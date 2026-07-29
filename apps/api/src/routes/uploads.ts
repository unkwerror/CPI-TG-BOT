import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { artifacts, events, outboxEvents, submissions, uploadParts } from '@cpi/db';
import {
  AppError,
  canAccessArtifact,
  evaluateFilePolicy,
  eventAcceptsUploads,
  normalizePartList,
  planUpload,
  sanitizeDisplayName,
  uploadCompleteSchema,
  uploadInitSchema,
  type ArtifactKind,
  type UploadInitResponse,
} from '@cpi/shared';
import { serializeArtifact } from '../serializers';

const partUrlSchema = z.object({
  partNumber: z.coerce.number().int().min(1).max(10_000),
});

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
    const uploadUrl = await getSignedUrl(
      app.s3Public,
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
      uploadUrl,
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
      const body = uploadInitSchema.parse(request.body);
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
      const maximum = Math.min(
        Number(context.event.maxFileSizeBytes),
        app.config.GLOBAL_MAX_FILE_SIZE_BYTES,
      );
      const policy = evaluateFilePolicy({
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        maxFileSizeBytes: maximum,
        allowedMimeTypes: context.event.allowedMimeTypes,
        blockedExtensions: context.event.blockedExtensions,
      });
      if (!policy.allowed) throw new AppError(policy.code, policy.reason, 413);

      const artifactId = randomUUID();
      const objectKey = `${context.event.id}/${context.submission.id}/${artifactId}`;
      let multipartUploadId: string | null = null;
      if (body.sizeBytes >= app.config.MULTIPART_THRESHOLD_BYTES) {
        const result = await app.s3Internal.send(
          new CreateMultipartUploadCommand({
            Bucket: app.config.S3_QUARANTINE_BUCKET,
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

      const [created] = await app.db
        .insert(artifacts)
        .values({
          id: artifactId,
          submissionId: context.submission.id,
          eventId: context.event.id,
          userId: request.currentUser!.id,
          kind: inferKind(body.mimeType, policy.extension),
          originalName: body.fileName,
          displayName: sanitizeDisplayName(body.fileName),
          mimeType: body.mimeType,
          extension: policy.extension,
          sizeBytes: body.sizeBytes,
          bucket: app.config.S3_QUARANTINE_BUCKET,
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
      await app.db
        .update(submissions)
        .set({ status: 'processing' })
        .where(eq(submissions.id, context.submission.id));
      return reply.code(201).send(await presignInitialUpload(created));
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
        app.s3Public,
        new UploadPartCommand({
          Bucket: artifact.bucket,
          Key: artifact.objectKey,
          UploadId: artifact.uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: app.config.PRESIGNED_URL_TTL_SECONDS },
      );
      return { url, partNumber, expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS };
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
      if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Файл не найден', 404);
      if (['uploaded', 'verifying', 'ready'].includes(artifact.status)) {
        await enqueueVerification(app, artifact.id);
        return serializeArtifact(artifact);
      }
      if (artifact.status !== 'uploading') {
        throw new AppError(
          'UPLOAD_STATE_INVALID',
          'Загрузку нельзя завершить в текущем состоянии',
          409,
        );
      }

      let etag: string | null = null;
      const normalizedParts = normalizePartList(body.parts);
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
        const result = await app.s3Internal.send(
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
      } else {
        const head = await app.s3Internal.send(
          new HeadObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
        );
        etag = head.ETag ?? null;
      }

      const updated = await app.db.transaction(async (transaction) => {
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
          .set({ status: 'uploaded', etag, statusReason: null })
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
      await enqueueVerification(app, artifact.id);
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
        if (artifact.uploadId) {
          await app.s3Internal.send(
            new AbortMultipartUploadCommand({
              Bucket: artifact.bucket,
              Key: artifact.objectKey,
              UploadId: artifact.uploadId,
            }),
          );
        } else {
          await app.s3Internal.send(
            new DeleteObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
          );
        }
      } catch (error) {
        app.log.warn({ error, artifactId }, 'S3 abort failed; cleanup worker will retry');
      }
      await app.db
        .update(artifacts)
        .set({ status: 'failed', statusReason: 'Загрузка отменена пользователем' })
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
        app.s3Public,
        new GetObjectCommand({
          Bucket: artifact.bucket,
          Key: artifact.objectKey,
          ResponseContentType: artifact.mimeType,
          ResponseContentDisposition: disposition,
        }),
        { expiresIn: app.config.PRESIGNED_URL_TTL_SECONDS },
      );
      return { url, expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS };
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
      return reply.code(204).send();
    },
  );
};
