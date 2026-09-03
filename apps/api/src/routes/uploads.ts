import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  artifacts,
  eventArtifactFields,
  events,
  outboxEvents,
  submissions,
  uploadParts,
} from '@cpi/db';
import {
  AppError,
  canAccessArtifact,
  evaluateFilePolicy,
  eventAcceptsUploads,
  incomingObjectKey,
  normalizePartList,
  planUpload,
  publicStorageUrl,
  sanitizeDisplayName,
  uploadCompleteSchema,
  uploadInitSchema,
  type ArtifactKind,
  type UploadInitResponse,
} from '@cpi/shared';
import { deleteArtifactObjects } from '../artifact-storage';
import { invalidateEventExports } from '../export-storage';
import { serializeArtifact } from '../serializers';

const partUrlSchema = z.object({
  partNumber: z.coerce.number().int().min(1).max(10_000),
});
const formUploadInitSchema = uploadInitSchema.extend({ formFieldId: z.uuid().optional() });
const FILE_FIELD_KINDS = new Set(['file', 'image', 'document', 'audio', 'video', 'archive']);

function isMissingMultipartUpload(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NoSuchUpload' ||
    candidate.Code === 'NoSuchUpload' ||
    candidate.code === 'NoSuchUpload' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function inferKind(mimeType: string, extension: string): ArtifactKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (
    ['zip', 'rar', '7z', 'tar', 'gz'].includes(extension) ||
    ['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'].includes(
      mimeType,
    )
  ) {
    return 'archive';
  }
  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    mimeType.includes('document') ||
    mimeType.includes('sheet') ||
    mimeType.includes('presentation')
  ) {
    return 'document';
  }
  return 'file';
}

function assertUploadReplayMatches(
  existing: typeof artifacts.$inferSelect,
  body: z.infer<typeof formUploadInitSchema>,
): void {
  if (
    existing.submissionId !== body.submissionId ||
    existing.originalName !== body.fileName ||
    existing.mimeType !== body.mimeType ||
    Number(existing.sizeBytes) !== body.sizeBytes ||
    (existing.formFieldId ?? null) !== (body.formFieldId ?? null)
  ) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Этот Idempotency-Key уже использован для другого файла',
      409,
    );
  }
}

async function enqueueVerification(
  app: Parameters<FastifyPluginAsync>[0],
  artifactId: string,
): Promise<void> {
  try {
    await app.artifactQueue.add(
      'verify-artifact',
      { artifactId },
      {
        jobId: artifactId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 500,
        removeOnFail: 1_000,
      },
    );
  } catch (error) {
    app.log.warn({ error, artifactId }, 'Verification queue unavailable; outbox will retry');
  }
}

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  async function presignInitialUpload(
    artifact: typeof artifacts.$inferSelect,
  ): Promise<UploadInitResponse> {
    if (artifact.uploadId) {
      return {
        artifactId: artifact.id,
        uploadType: 'multipart',
        partSize: app.config.MULTIPART_PART_SIZE_BYTES,
        expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS,
        ...(['uploaded', 'verifying', 'ready'].includes(artifact.status)
          ? { alreadyCompleted: true }
          : {}),
      };
    }
    if (['uploaded', 'verifying', 'ready'].includes(artifact.status)) {
      return {
        artifactId: artifact.id,
        uploadType: 'simple',
        expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS,
        alreadyCompleted: true,
      };
    }
    const signedUploadUrl = await getSignedUrl(
      app.s3,
      new PutObjectCommand({
        Bucket: artifact.bucket,
        Key: artifact.objectKey,
        ContentType: artifact.mimeType,
        ContentLength: artifact.sizeBytes,
        Metadata: {
          artifact: artifact.id,
          submission: artifact.submissionId,
        },
      }),
      { expiresIn: app.config.PRESIGNED_URL_TTL_SECONDS },
    );
    return {
      artifactId: artifact.id,
      uploadType: 'simple',
      uploadUrl: publicStorageUrl(signedUploadUrl, app.config.S3_PUBLIC_BASE),
      expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS,
    };
  }

  app.post(
    '/uploads/init',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
      schema: { tags: ['uploads'] },
    },
    async (request, reply) => {
      const body = formUploadInitSchema.parse(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 128
      ) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REQUIRED',
          'Передайте уникальный заголовок Idempotency-Key',
          400,
        );
      }
      const [existing] = await app.db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.userId, request.currentUser!.id),
            eq(artifacts.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        assertUploadReplayMatches(existing, body);
        if (['failed', 'deleted', 'quarantined'].includes(existing.status)) {
          throw new AppError(
            'UPLOAD_NOT_REUSABLE',
            'Эта попытка завершилась ошибкой; создайте новую попытку',
            409,
          );
        }
        return presignInitialUpload(existing);
      }

      const [context] = await app.db
        .select({ submission: submissions, event: events })
        .from(submissions)
        .innerJoin(events, eq(events.id, submissions.eventId))
        .where(
          and(
            eq(submissions.id, body.submissionId),
            eq(submissions.userId, request.currentUser!.id),
            isNull(submissions.deletedAt),
            isNull(events.deletedAt),
          ),
        )
        .limit(1);
      if (!context) throw new AppError('SUBMISSION_NOT_FOUND', 'Отправка не найдена', 404);
      if (!eventAcceptsUploads(context.event)) {
        throw new AppError('EVENT_UPLOADS_CLOSED', 'Приём материалов сейчас закрыт', 409);
      }
      let formField: typeof eventArtifactFields.$inferSelect | null = null;
      if (context.submission.formVersionId) {
        if (!body.formFieldId) {
          throw new AppError('FORM_FIELD_REQUIRED', 'Выберите поле формы для файла', 400);
        }
        const [selectedFormField] = await app.db
          .select()
          .from(eventArtifactFields)
          .where(
            and(
              eq(eventArtifactFields.id, body.formFieldId),
              eq(eventArtifactFields.formVersionId, context.submission.formVersionId),
            ),
          )
          .limit(1);
        formField = selectedFormField ?? null;
        if (!formField || !FILE_FIELD_KINDS.has(formField.kind)) {
          throw new AppError('FORM_FILE_FIELD_INVALID', 'Поле файла не принадлежит форме', 400);
        }
        const currentFiles = await app.db
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.submissionId, context.submission.id),
              eq(artifacts.formFieldId, formField.id),
              isNull(artifacts.deletedAt),
            ),
          )
          .limit(formField.maxItems);
        if (currentFiles.length >= formField.maxItems) {
          throw new AppError(
            'FORM_FILE_LIMIT',
            `Для поля «${formField.label}» достигнут лимит`,
            409,
          );
        }
      } else if (body.formFieldId) {
        throw new AppError('FORM_FILE_FIELD_INVALID', 'У отправки нет версии формы', 400);
      }
      const maximum = Math.min(
        Number(context.event.maxFileSizeBytes),
        formField?.maxFileSizeBytes ?? Number.POSITIVE_INFINITY,
        app.config.GLOBAL_MAX_FILE_SIZE_BYTES,
      );
      const policy = evaluateFilePolicy({
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        maxFileSizeBytes: maximum,
        allowedMimeTypes:
          formField && formField.allowedMimeTypes.length > 0
            ? formField.allowedMimeTypes
            : context.event.allowedMimeTypes,
        blockedExtensions: context.event.blockedExtensions,
      });
      if (!policy.allowed) throw new AppError(policy.code, policy.reason, 413);
      if (
        formField &&
        formField.allowedExtensions.length > 0 &&
        !formField.allowedExtensions.map((item) => item.toLowerCase()).includes(policy.extension)
      ) {
        throw new AppError(
          'FILE_TYPE_NOT_ALLOWED',
          `Расширение файла не подходит для «${formField.label}»`,
          413,
        );
      }
      const inferredKind = inferKind(body.mimeType, policy.extension);
      if (formField && formField.kind !== 'file' && formField.kind !== inferredKind) {
        throw new AppError(
          'FILE_TYPE_NOT_ALLOWED',
          `Тип файла не подходит для «${formField.label}»`,
          413,
        );
      }

      const artifactId = randomUUID();
      const objectKey = incomingObjectKey(app.config.S3_PREFIX, {
        eventId: context.event.id,
        submissionId: context.submission.id,
        artifactId,
      });
      let multipartUploadId: string | null = null;
      if (body.sizeBytes >= app.config.MULTIPART_THRESHOLD_BYTES) {
        const result = await app.s3.send(
          new CreateMultipartUploadCommand({
            Bucket: app.config.S3_BUCKET,
            Key: objectKey,
            ContentType: body.mimeType,
            Metadata: {
              artifact: artifactId,
              submission: context.submission.id,
            },
          }),
        );
        if (!result.UploadId) throw new Error('S3 did not return a multipart upload id');
        multipartUploadId = result.UploadId;
      }

      let reservation: { artifact: typeof artifacts.$inferSelect; replayed: boolean };
      try {
        reservation = await app.db.transaction(async (transaction) => {
          // Serialize both retries of one request and distinct uploads targeting the same field.
          // The latter makes maxItems a real invariant instead of a racy preflight hint.
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`upload-init:${request.currentUser!.id}:${idempotencyKey}`}, 0))`,
          );
          const [racedExisting] = await transaction
            .select()
            .from(artifacts)
            .where(
              and(
                eq(artifacts.userId, request.currentUser!.id),
                eq(artifacts.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (racedExisting) {
            assertUploadReplayMatches(racedExisting, body);
            if (['failed', 'deleted', 'quarantined'].includes(racedExisting.status)) {
              throw new AppError(
                'UPLOAD_NOT_REUSABLE',
                'Эта попытка завершилась ошибкой; создайте новую попытку',
                409,
              );
            }
            return { artifact: racedExisting, replayed: true };
          }
          if (formField) {
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`form-upload:${context.submission.id}:${formField.id}`}, 0))`,
            );
            const [usage] = await transaction
              .select({ value: count() })
              .from(artifacts)
              .where(
                and(
                  eq(artifacts.submissionId, context.submission.id),
                  eq(artifacts.formFieldId, formField.id),
                  isNull(artifacts.deletedAt),
                ),
              );
            if (Number(usage?.value ?? 0) >= formField.maxItems) {
              throw new AppError(
                'FORM_FILE_LIMIT',
                `Для поля «${formField.label}» достигнут лимит`,
                409,
              );
            }
          }
          const [created] = await transaction
            .insert(artifacts)
            .values({
              id: artifactId,
              submissionId: context.submission.id,
              eventId: context.event.id,
              userId: request.currentUser!.id,
              kind: inferredKind,
              formFieldId: formField?.id ?? null,
              originalName: body.fileName,
              displayName: sanitizeDisplayName(body.fileName),
              mimeType: body.mimeType,
              extension: policy.extension,
              sizeBytes: body.sizeBytes,
              bucket: app.config.S3_BUCKET,
              objectKey,
              uploadId: multipartUploadId,
              status: 'uploading',
              statusReason: policy.requiresQuarantine
                ? 'Формат требует обязательной антивирусной проверки'
                : null,
              idempotencyKey,
            })
            .returning();
          if (!created) throw new Error('Artifact insert returned no row');
          await transaction
            .update(submissions)
            .set({ status: 'processing' })
            .where(eq(submissions.id, context.submission.id));
          return { artifact: created, replayed: false };
        });
      } catch (error) {
        if (multipartUploadId) {
          try {
            await app.s3.send(
              new AbortMultipartUploadCommand({
                Bucket: app.config.S3_BUCKET,
                Key: objectKey,
                UploadId: multipartUploadId,
              }),
            );
          } catch (abortError) {
            app.log.warn(
              { error: abortError, artifactId, objectKey },
              'Multipart upload cleanup after reservation failure failed',
            );
          }
        }
        throw error;
      }
      if (reservation.replayed && multipartUploadId) {
        try {
          await app.s3.send(
            new AbortMultipartUploadCommand({
              Bucket: app.config.S3_BUCKET,
              Key: objectKey,
              UploadId: multipartUploadId,
            }),
          );
        } catch (error) {
          app.log.warn(
            { error, artifactId, objectKey },
            'Redundant multipart upload cleanup after idempotent replay failed',
          );
        }
      }
      try {
        await invalidateEventExports(
          app,
          context.event.id,
          'Недействительна после добавления файла',
        );
      } catch (error) {
        app.log.warn(
          { error, eventId: context.event.id },
          'Export invalidation after artifact creation failed',
        );
      }
      return reply
        .code(reservation.replayed ? 200 : 201)
        .send(await presignInitialUpload(reservation.artifact));
    },
  );

  app.get(
    '/uploads/:artifactId/part-url',
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: { tags: ['uploads'] },
    },
    async (request) => {
      const { artifactId } = request.params as { artifactId: string };
      const { partNumber } = partUrlSchema.parse(request.query);
      const [artifact] = await app.db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, artifactId),
            eq(artifacts.userId, request.currentUser!.id),
            isNull(artifacts.deletedAt),
          ),
        )
        .limit(1);
      if (!artifact || !artifact.uploadId) {
        throw new AppError('MULTIPART_UPLOAD_NOT_FOUND', 'Multipart-загрузка не найдена', 404);
      }
      if (artifact.status !== 'uploading') {
        throw new AppError('UPLOAD_ALREADY_COMPLETED', 'Загрузка уже завершена', 409);
      }
      const totalParts = Math.ceil(
        Number(artifact.sizeBytes) / app.config.MULTIPART_PART_SIZE_BYTES,
      );
      if (partNumber > totalParts) {
        throw new AppError('PART_NUMBER_INVALID', 'Номер части превышает размер файла', 400);
      }
      const url = await getSignedUrl(
        app.s3,
        new UploadPartCommand({
          Bucket: artifact.bucket,
          Key: artifact.objectKey,
          UploadId: artifact.uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: app.config.PRESIGNED_URL_TTL_SECONDS },
      );
      return {
        url: publicStorageUrl(url, app.config.S3_PUBLIC_BASE),
        partNumber,
        expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS,
      };
    },
  );

  app.post(
    '/uploads/:artifactId/complete',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['uploads'] },
    },
    async (request) => {
      const { artifactId } = request.params as { artifactId: string };
      const body = uploadCompleteSchema.parse(request.body);
      const normalizedParts = normalizePartList(body.parts);
      const updated = await app.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`artifact-complete:${artifactId}`}, 0))`,
        );
        const [artifact] = await transaction
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, artifactId),
              eq(artifacts.userId, request.currentUser!.id),
              isNull(artifacts.deletedAt),
            ),
          )
          .for('update')
          .limit(1);
        if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Файл не найден', 404);
        if (['uploaded', 'verifying', 'ready'].includes(artifact.status)) return artifact;
        if (artifact.status !== 'uploading') {
          throw new AppError(
            'UPLOAD_STATE_INVALID',
            'Загрузку нельзя завершить в текущем состоянии',
            409,
          );
        }

        let etag: string | null = null;
        if (artifact.uploadId) {
          const expectedParts = planUpload(
            Number(artifact.sizeBytes),
            app.config.MULTIPART_THRESHOLD_BYTES,
            app.config.MULTIPART_PART_SIZE_BYTES,
          ).partCount;
          if (normalizedParts.length !== expectedParts) {
            throw new AppError(
              'MULTIPART_INCOMPLETE',
              `Передано частей: ${normalizedParts.length}, ожидается: ${expectedParts}`,
              409,
            );
          }
          try {
            const result = await app.s3.send(
              new CompleteMultipartUploadCommand({
                Bucket: artifact.bucket,
                Key: artifact.objectKey,
                UploadId: artifact.uploadId,
                MultipartUpload: {
                  Parts: normalizedParts.map((part) => ({
                    PartNumber: part.partNumber,
                    ETag: part.etag,
                  })),
                },
              }),
            );
            etag = result.ETag ?? null;
          } catch (error) {
            if (!isMissingMultipartUpload(error)) throw error;
            // CompleteMultipartUpload is not idempotent at S3 level. A process can crash after
            // S3 assembles the object but before PostgreSQL commits; on retry Beget correctly
            // returns NoSuchUpload. HEAD below distinguishes that success from a missing upload.
          }
        }

        let head;
        try {
          head = await app.s3.send(
            new HeadObjectCommand({
              Bucket: artifact.bucket,
              Key: artifact.objectKey,
            }),
          );
        } catch (error) {
          if (artifact.uploadId && isMissingMultipartUpload(error)) {
            throw new AppError(
              'MULTIPART_UPLOAD_NOT_FOUND',
              'Multipart-загрузка не найдена. Начните загрузку файла заново.',
              409,
            );
          }
          throw error;
        }
        if (
          head.ContentLength !== Number(artifact.sizeBytes) ||
          head.Metadata?.artifact !== artifact.id ||
          head.Metadata?.submission !== artifact.submissionId
        ) {
          throw new AppError(
            'UPLOADED_OBJECT_MISMATCH',
            'Загруженный объект не соответствует заявленному файлу',
            409,
          );
        }
        etag ??= head.ETag ?? null;

        for (const part of normalizedParts) {
          await transaction
            .insert(uploadParts)
            .values({
              artifactId: artifact.id,
              partNumber: part.partNumber,
              etag: part.etag,
            })
            .onConflictDoUpdate({
              target: [uploadParts.artifactId, uploadParts.partNumber],
              set: { etag: part.etag },
            });
        }
        const [row] = await transaction
          .update(artifacts)
          .set({ status: 'uploaded', etag, uploadId: null, statusReason: null })
          .where(and(eq(artifacts.id, artifact.id), eq(artifacts.status, 'uploading')))
          .returning();
        await transaction
          .insert(outboxEvents)
          .values({
            type: 'artifact.uploaded',
            aggregateType: 'artifact',
            aggregateId: artifact.id,
            payload: { artifactId: artifact.id },
          })
          .onConflictDoNothing();
        return row ?? artifact;
      });
      await enqueueVerification(app, updated.id);
      return serializeArtifact(updated);
    },
  );

  app.post(
    '/uploads/:artifactId/abort',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['uploads'] },
    },
    async (request, reply) => {
      const { artifactId } = request.params as { artifactId: string };
      const [artifact] = await app.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, request.currentUser!.id)))
        .limit(1);
      if (!artifact) return reply.code(204).send();
      if (artifact.status === 'ready') {
        throw new AppError('UPLOAD_ALREADY_COMPLETED', 'Готовый файл нельзя отменить', 409);
      }
      try {
        await deleteArtifactObjects(app, [artifact]);
      } catch (error) {
        app.log.warn({ error, artifactId }, 'S3 abort failed; cleanup worker will retry');
      }
      await app.db
        .update(artifacts)
        .set({
          status: 'deleted',
          statusReason: 'Загрузка отменена пользователем',
          deletedAt: new Date(),
        })
        .where(eq(artifacts.id, artifact.id));
      return reply.code(204).send();
    },
  );

  app.get(
    '/artifacts/:artifactId/download',
    { preHandler: app.requireAuth, schema: { tags: ['artifacts'] } },
    async (request) => {
      const { artifactId } = request.params as { artifactId: string };
      const [artifact] = await app.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .limit(1);
      if (
        !artifact ||
        !canAccessArtifact({
          currentUserId: request.currentUser!.id,
          artifactOwnerId: artifact.userId,
          roles: request.currentUser!.roles,
          status: artifact.status,
        })
      ) {
        throw new AppError('ARTIFACT_NOT_FOUND', 'Файл не найден', 404);
      }
      if (artifact.status !== 'ready') {
        throw new AppError('ARTIFACT_NOT_READY', 'Файл ещё не прошёл проверку', 409);
      }
      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(artifact.displayName)}`;
      const url = await getSignedUrl(
        app.s3,
        new GetObjectCommand({
          Bucket: artifact.bucket,
          Key: artifact.objectKey,
          ResponseContentType: artifact.mimeType,
          ResponseContentDisposition: disposition,
        }),
        { expiresIn: app.config.PRESIGNED_URL_TTL_SECONDS },
      );
      return {
        url: publicStorageUrl(url, app.config.S3_PUBLIC_BASE),
        expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS,
      };
    },
  );

  app.delete(
    '/artifacts/:artifactId',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['artifacts'] },
    },
    async (request, reply) => {
      const { artifactId } = request.params as { artifactId: string };
      const [row] = await app.db
        .select({ artifact: artifacts, event: events })
        .from(artifacts)
        .innerJoin(events, eq(events.id, artifacts.eventId))
        .where(
          and(
            eq(artifacts.id, artifactId),
            eq(artifacts.userId, request.currentUser!.id),
            isNull(artifacts.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw new AppError('ARTIFACT_NOT_FOUND', 'Файл не найден', 404);
      if (!eventAcceptsUploads(row.event)) {
        throw new AppError('EVENT_UPLOADS_CLOSED', 'Удаление после закрытия приёма запрещено', 409);
      }
      await app.db
        .update(artifacts)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(eq(artifacts.id, artifactId));
      try {
        await deleteArtifactObjects(app, [row.artifact]);
      } catch (error) {
        app.log.warn({ error, artifactId }, 'Artifact storage cleanup deferred');
      }
      try {
        await invalidateEventExports(
          app,
          row.artifact.eventId,
          'Недействительна после удаления файла',
        );
      } catch (error) {
        app.log.warn(
          { error, eventId: row.artifact.eventId },
          'Export invalidation after artifact deletion failed',
        );
      }
      return reply.code(204).send();
    },
  );
};
