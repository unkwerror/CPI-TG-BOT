import { randomUUID } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { customCardPackages, events, feedPosts, storeProducts } from '@cpi/db';
import { AppError, publicStorageUrl } from '@cpi/shared';
import { writeAudit } from '../audit';
import {
  assertCardPackageHead,
  CARD_PACKAGE_CSP,
  CARD_PACKAGE_MAX_ZIP_BYTES,
  CARD_PACKAGE_UPLOAD_TTL_SECONDS,
  cardPackageObjectPrefix,
  cardPackagePutHeaders,
  cardPackageSourceObjectKey,
  cardPackageUploadMetadata,
  deleteCardPackageObjects,
  downloadCardPackageZip,
  extractCardPackage,
  getCardPackageFile,
  isNodeReadable,
  normalizeCardPackagePath,
  renderCardPackageDocument,
  rewriteCardPackageAssetReferences,
  uploadCardPackageFiles,
  type CardPackageEntityType,
} from '../card-package';

const packageIdParams = z.object({ packageId: z.uuid() });
const cardPackageTargetSchema = z.object({
  entityType: z.enum(['event', 'product', 'feed_post']),
  entityId: z.uuid(),
});
const uploadInitSchema = cardPackageTargetSchema.extend({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/\.zip$/iu, 'Выберите ZIP-файл')
    .refine((value) => !value.includes('/') && !value.includes('\\'), {
      message: 'Имя ZIP не должно содержать путь',
    }),
  sizeBytes: z.number().int().positive().max(CARD_PACKAGE_MAX_ZIP_BYTES),
});
const uploadCompleteSchema = uploadInitSchema.extend({
  packageId: z.uuid(),
});

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function loadTarget(
  app: Parameters<FastifyPluginAsync>[0],
  entityType: CardPackageEntityType,
  entityId: string,
): Promise<{ id: string; cardPackageId: string | null }> {
  if (entityType === 'event') {
    const [target] = await app.db
      .select({ id: events.id, cardPackageId: events.cardPackageId })
      .from(events)
      .where(and(eq(events.id, entityId), isNull(events.deletedAt)))
      .limit(1);
    if (target) return target;
  } else if (entityType === 'product') {
    const [target] = await app.db
      .select({
        id: storeProducts.id,
        cardPackageId: storeProducts.cardPackageId,
      })
      .from(storeProducts)
      .where(and(eq(storeProducts.id, entityId), isNull(storeProducts.deletedAt)))
      .limit(1);
    if (target) return target;
  } else {
    const [target] = await app.db
      .select({ id: feedPosts.id, cardPackageId: feedPosts.cardPackageId })
      .from(feedPosts)
      .where(eq(feedPosts.id, entityId))
      .limit(1);
    if (target) return target;
  }
  throw new AppError(
    'CARD_PACKAGE_TARGET_NOT_FOUND',
    'Товар, публикация или мероприятие не найдено',
    404,
  );
}

function packageObjectKeys(cardPackage: typeof customCardPackages.$inferSelect): string[] {
  return [cardPackage.sourceObjectKey, ...cardPackage.files.map((file) => file.objectKey)];
}

function setCardPackageHeaders(reply: FastifyReply): void {
  reply
    .header('Content-Security-Policy', CARD_PACKAGE_CSP)
    .header('Cross-Origin-Resource-Policy', 'cross-origin')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff');
}

export const cardPackageRoutes: FastifyPluginAsync = async (app) => {
  const writeGuards = [app.requireAuth, app.requireCsrf, app.requireAdmin];

  app.post(
    '/admin/card-packages/uploads',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = uploadInitSchema.parse(request.body);
      await loadTarget(app, body.entityType, body.entityId);
      const packageId = randomUUID();
      const sourceObjectKey = cardPackageSourceObjectKey(
        app.config.S3_PREFIX,
        body.entityType,
        body.entityId,
        packageId,
      );
      const metadata = cardPackageUploadMetadata({
        packageId,
        entityType: body.entityType,
        entityId: body.entityId,
        sizeBytes: body.sizeBytes,
      });
      const uploadUrl = publicStorageUrl(
        await getSignedUrl(
          app.s3,
          new PutObjectCommand({
            Bucket: app.config.S3_BUCKET,
            Key: sourceObjectKey,
            ContentType: 'application/zip',
            Metadata: metadata,
          }),
          { expiresIn: CARD_PACKAGE_UPLOAD_TTL_SECONDS },
        ),
        app.config.S3_PUBLIC_BASE,
      );
      await writeAudit(request, {
        action: 'card_package.upload.init',
        entityType: body.entityType,
        entityId: body.entityId,
        metadata: {
          packageId,
          fileName: body.fileName,
          sizeBytes: body.sizeBytes,
        },
      });
      return reply.code(201).send({
        packageId,
        uploadUrl,
        method: 'PUT' as const,
        headers: cardPackagePutHeaders({
          packageId,
          entityType: body.entityType,
          entityId: body.entityId,
          sizeBytes: body.sizeBytes,
        }),
        expiresInSeconds: CARD_PACKAGE_UPLOAD_TTL_SECONDS,
      });
    },
  );

  app.post(
    '/admin/card-packages/complete',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = uploadCompleteSchema.parse(request.body);
      const [alreadyCompleted] = await app.db
        .select()
        .from(customCardPackages)
        .where(eq(customCardPackages.id, body.packageId))
        .limit(1);
      if (alreadyCompleted) {
        return {
          cardPackageId: alreadyCompleted.id,
          package: {
            id: alreadyCompleted.id,
            fileName: alreadyCompleted.sourceFileName,
            sizeBytes: alreadyCompleted.sourceSizeBytes,
            fileCount: alreadyCompleted.files.length,
            totalUncompressedBytes: alreadyCompleted.totalUncompressedBytes,
          },
        };
      }
      await loadTarget(app, body.entityType, body.entityId);
      const sourceObjectKey = cardPackageSourceObjectKey(
        app.config.S3_PREFIX,
        body.entityType,
        body.entityId,
        body.packageId,
      );
      const cleanupNewPackage = async (objectKeys: string[]) => {
        await deleteCardPackageObjects(app.s3, app.config.S3_BUCKET, [
          sourceObjectKey,
          ...objectKeys,
        ]).catch((error) => {
          app.log.warn(
            { error, packageId: body.packageId },
            'Failed to clean rejected card package',
          );
        });
      };
      let uploadedObjectKeys: string[] = [];
      try {
        const head = await app.s3.send(
          new HeadObjectCommand({
            Bucket: app.config.S3_BUCKET,
            Key: sourceObjectKey,
          }),
        );
        assertCardPackageHead(body, head);
        const archive = await downloadCardPackageZip(app.s3, app.config.S3_BUCKET, sourceObjectKey);
        const extracted = await extractCardPackage(archive);
        const objectPrefix = cardPackageObjectPrefix(
          app.config.S3_PREFIX,
          body.entityType,
          body.entityId,
          body.packageId,
        );
        const files = await uploadCardPackageFiles({
          s3: app.s3,
          bucket: app.config.S3_BUCKET,
          objectPrefix,
          packageId: body.packageId,
          files: extracted.files,
        });
        uploadedObjectKeys = files.map((file) => file.objectKey);
        const oldPackage = await app.db.transaction(async (transaction) => {
          let oldPackageId: string | null = null;
          if (body.entityType === 'event') {
            const [target] = await transaction
              .select({ cardPackageId: events.cardPackageId })
              .from(events)
              .where(and(eq(events.id, body.entityId), isNull(events.deletedAt)))
              .for('update')
              .limit(1);
            if (!target)
              throw new AppError('CARD_PACKAGE_TARGET_NOT_FOUND', 'Мероприятие не найдено', 404);
            oldPackageId = target.cardPackageId;
          } else if (body.entityType === 'product') {
            const [target] = await transaction
              .select({ cardPackageId: storeProducts.cardPackageId })
              .from(storeProducts)
              .where(and(eq(storeProducts.id, body.entityId), isNull(storeProducts.deletedAt)))
              .for('update')
              .limit(1);
            if (!target)
              throw new AppError('CARD_PACKAGE_TARGET_NOT_FOUND', 'Товар не найден', 404);
            oldPackageId = target.cardPackageId;
          } else {
            const [target] = await transaction
              .select({ cardPackageId: feedPosts.cardPackageId })
              .from(feedPosts)
              .where(eq(feedPosts.id, body.entityId))
              .for('update')
              .limit(1);
            if (!target)
              throw new AppError('CARD_PACKAGE_TARGET_NOT_FOUND', 'Публикация не найдена', 404);
            oldPackageId = target.cardPackageId;
          }
          const old = oldPackageId
            ? (
                await transaction
                  .select()
                  .from(customCardPackages)
                  .where(eq(customCardPackages.id, oldPackageId))
                  .limit(1)
              )[0]
            : undefined;
          await transaction.insert(customCardPackages).values({
            id: body.packageId,
            entityType: body.entityType,
            entityId: body.entityId,
            sourceFileName: body.fileName,
            sourceBucket: app.config.S3_BUCKET,
            sourceObjectKey,
            sourceSizeBytes: body.sizeBytes,
            entryPath: extracted.entryPath,
            entryHtml: extracted.entryHtml,
            files,
            totalUncompressedBytes: extracted.totalUncompressedBytes,
            createdBy: request.currentUser!.id,
          });
          if (body.entityType === 'event') {
            await transaction
              .update(events)
              .set({
                cardPackageId: body.packageId,
                updatedBy: request.currentUser!.id,
                updatedAt: new Date(),
              })
              .where(eq(events.id, body.entityId));
          } else if (body.entityType === 'product') {
            await transaction
              .update(storeProducts)
              .set({
                cardPackageId: body.packageId,
                updatedBy: request.currentUser!.id,
                updatedAt: new Date(),
              })
              .where(eq(storeProducts.id, body.entityId));
          } else {
            await transaction
              .update(feedPosts)
              .set({
                cardPackageId: body.packageId,
                updatedBy: request.currentUser!.id,
                updatedAt: new Date(),
              })
              .where(eq(feedPosts.id, body.entityId));
          }
          if (old) {
            await transaction.delete(customCardPackages).where(eq(customCardPackages.id, old.id));
          }
          return old;
        });
        if (oldPackage) {
          await deleteCardPackageObjects(
            app.s3,
            oldPackage.sourceBucket,
            packageObjectKeys(oldPackage),
          ).catch((error) => {
            app.log.warn(
              { error, packageId: oldPackage.id },
              'Failed to remove replaced card package objects',
            );
          });
        }
        await writeAudit(request, {
          action: 'card_package.apply',
          entityType: body.entityType,
          entityId: body.entityId,
          metadata: {
            packageId: body.packageId,
            fileName: body.fileName,
            fileCount: files.length,
            totalUncompressedBytes: extracted.totalUncompressedBytes,
          },
        });
        return {
          cardPackageId: body.packageId,
          package: {
            id: body.packageId,
            fileName: body.fileName,
            sizeBytes: body.sizeBytes,
            fileCount: files.length,
            totalUncompressedBytes: extracted.totalUncompressedBytes,
          },
        };
      } catch (error) {
        if (isMissingObject(error)) {
          throw new AppError('CARD_PACKAGE_NOT_UPLOADED', 'ZIP ещё не появился в Beget S3', 409);
        }
        await cleanupNewPackage(uploadedObjectKeys);
        throw error;
      }
    },
  );

  app.delete(
    '/admin/card-packages/:packageId',
    { preHandler: writeGuards },
    async (request, reply) => {
      const { packageId } = packageIdParams.parse(request.params);
      const [cardPackage] = await app.db
        .select()
        .from(customCardPackages)
        .where(eq(customCardPackages.id, packageId))
        .limit(1);
      if (!cardPackage)
        throw new AppError('CARD_PACKAGE_NOT_FOUND', 'ZIP-оформление не найдено', 404);
      await app.db.transaction(async (transaction) => {
        if (cardPackage.entityType === 'event') {
          await transaction
            .update(events)
            .set({ cardPackageId: null, updatedAt: new Date() })
            .where(
              and(eq(events.id, cardPackage.entityId), eq(events.cardPackageId, cardPackage.id)),
            );
        } else if (cardPackage.entityType === 'product') {
          await transaction
            .update(storeProducts)
            .set({ cardPackageId: null, updatedAt: new Date() })
            .where(
              and(
                eq(storeProducts.id, cardPackage.entityId),
                eq(storeProducts.cardPackageId, cardPackage.id),
              ),
            );
        } else {
          await transaction
            .update(feedPosts)
            .set({ cardPackageId: null, updatedAt: new Date() })
            .where(
              and(
                eq(feedPosts.id, cardPackage.entityId),
                eq(feedPosts.cardPackageId, cardPackage.id),
              ),
            );
        }
        await transaction
          .delete(customCardPackages)
          .where(eq(customCardPackages.id, cardPackage.id));
      });
      await deleteCardPackageObjects(
        app.s3,
        cardPackage.sourceBucket,
        packageObjectKeys(cardPackage),
      ).catch((error) => {
        app.log.warn({ error, packageId }, 'Failed to remove card package objects');
      });
      await writeAudit(request, {
        action: 'card_package.delete',
        entityType: cardPackage.entityType,
        entityId: cardPackage.entityId,
        metadata: { packageId },
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/admin/card-packages/:packageId/source',
    { preHandler: [app.requireAuth, app.requireAdmin] },
    async (request) => {
      const { packageId } = packageIdParams.parse(request.params);
      const [cardPackage] = await app.db
        .select()
        .from(customCardPackages)
        .where(eq(customCardPackages.id, packageId))
        .limit(1);
      if (!cardPackage)
        throw new AppError('CARD_PACKAGE_NOT_FOUND', 'ZIP-оформление не найдено', 404);
      const url = await getSignedUrl(
        app.s3,
        new GetObjectCommand({
          Bucket: cardPackage.sourceBucket,
          Key: cardPackage.sourceObjectKey,
          ResponseContentType: 'application/zip',
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(cardPackage.sourceFileName)}`,
        }),
        { expiresIn: Math.min(app.config.PRESIGNED_URL_TTL_SECONDS, 900) },
      );
      return {
        fileName: cardPackage.sourceFileName,
        url: publicStorageUrl(url, app.config.S3_PUBLIC_BASE),
      };
    },
  );

  app.get('/card-packages/:packageId/render', async (request, reply) => {
    const { packageId } = packageIdParams.parse(request.params);
    const [cardPackage] = await app.db
      .select()
      .from(customCardPackages)
      .where(eq(customCardPackages.id, packageId))
      .limit(1);
    if (!cardPackage)
      throw new AppError('CARD_PACKAGE_NOT_FOUND', 'Оформление карточки не найдено', 404);
    setCardPackageHeaders(reply);
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .send(
        renderCardPackageDocument(
          cardPackage.id,
          cardPackage.entryPath,
          cardPackage.entryHtml,
          cardPackage.files.map((file) => file.path),
        ),
      );
  });

  app.get('/card-packages/:packageId/files/*', async (request, reply) => {
    const { packageId } = packageIdParams.parse(request.params);
    const rawPath = (request.params as { '*'?: string })['*'] ?? '';
    const path = normalizeCardPackagePath(rawPath);
    if (!path) throw new AppError('CARD_PACKAGE_FILE_NOT_FOUND', 'Файл оформления не найден', 404);
    const [cardPackage] = await app.db
      .select()
      .from(customCardPackages)
      .where(eq(customCardPackages.id, packageId))
      .limit(1);
    const file = cardPackage?.files.find((item) => item.path === path);
    if (!cardPackage || !file)
      throw new AppError('CARD_PACKAGE_FILE_NOT_FOUND', 'Файл оформления не найден', 404);
    const requestedRange = request.headers.range;
    const range =
      requestedRange && /^bytes=\d*-\d*$/u.test(requestedRange) ? requestedRange : undefined;
    const object = await getCardPackageFile(app.s3, cardPackage.sourceBucket, file, range);
    setCardPackageHeaders(reply);
    reply
      .type(file.contentType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Access-Control-Allow-Origin', '*')
      .header('Accept-Ranges', object.AcceptRanges ?? 'bytes');
    if (object.ContentRange) {
      reply.code(206).header('Content-Range', object.ContentRange);
    }
    const transformText =
      !range &&
      (file.contentType === 'image/svg+xml' ||
        /^(?:text\/|application\/(?:javascript|json))/iu.test(file.contentType));
    if (transformText) {
      const bytes = await (
        object.Body as { transformToByteArray?: () => Promise<Uint8Array> }
      )?.transformToByteArray?.();
      if (!bytes)
        throw new AppError(
          'CARD_PACKAGE_FILE_UNREADABLE',
          'Не удалось прочитать файл оформления из Beget S3',
          502,
        );
      const source = new TextDecoder('utf-8').decode(bytes);
      const transformed = file.contentType.startsWith('text/html')
        ? renderCardPackageDocument(
            cardPackage.id,
            file.path,
            source,
            cardPackage.files.map((item) => item.path),
          )
        : rewriteCardPackageAssetReferences(
            source,
            cardPackage.id,
            cardPackage.files.map((item) => item.path),
          );
      const output = Buffer.from(transformed);
      return reply.header('Content-Length', output.length).send(output);
    }
    if (object.ContentLength !== undefined) reply.header('Content-Length', object.ContentLength);
    if (isNodeReadable(object.Body)) return reply.send(object.Body);
    const bytes = await (
      object.Body as { transformToByteArray?: () => Promise<Uint8Array> }
    )?.transformToByteArray?.();
    if (!bytes)
      throw new AppError(
        'CARD_PACKAGE_FILE_UNREADABLE',
        'Не удалось прочитать файл оформления из Beget S3',
        502,
      );
    return reply.send(Buffer.from(bytes));
  });
};
