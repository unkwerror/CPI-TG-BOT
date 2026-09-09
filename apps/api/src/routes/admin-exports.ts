import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { artifacts, events, exportJobs, outboxEvents } from '@cpi/db';
import { AppError, exportCreateSchema, publicStorageUrl } from '@cpi/shared';
import { writeAudit } from '../audit';
import { invalidateEventExports } from '../export-storage';
import { serializeExportJob } from '../serializers';

export const adminExportRoutes: FastifyPluginAsync = async (app) => {
  const readGuards = [app.requireAuth, app.requireAdmin];
  const writeGuards = [app.requireAuth, app.requireCsrf, app.requireAdmin];

  app.post(
    '/admin/exports',
    { preHandler: writeGuards, schema: { tags: ['admin', 'exports'] } },
    async (request, reply) => {
      const body = exportCreateSchema.parse(request.body);
      if (body.eventId) {
        const [event] = await app.db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, body.eventId), isNull(events.deletedAt)))
          .limit(1);
        if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
      }

      const replaced = body.eventId
        ? await invalidateEventExports(
            app,
            body.eventId,
            'Заменена новой выгрузкой того же формата',
            body.kind,
          )
        : { invalidatedExports: 0, cleanupPending: false };
      const [job] = await app.db.transaction(async (transaction) => {
        const created = await transaction
          .insert(exportJobs)
          .values({
            eventId: body.eventId ?? null,
            scope: body.scope,
            requestedBy: request.currentUser!.id,
            kind: body.kind,
            status: 'queued',
          })
          .returning();
        if (!created[0]) throw new Error('Export insert returned no row');
        await transaction
          .insert(outboxEvents)
          .values({
            type: 'export.requested',
            aggregateType: 'export',
            aggregateId: created[0].id,
            payload: { exportJobId: created[0].id },
          })
          .onConflictDoNothing();
        return created;
      });
      if (!job) throw new Error('Export job missing after transaction');
      try {
        await app.exportQueue.add(
          'build-export',
          { exportJobId: job.id },
          {
            jobId: job.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 200,
            removeOnFail: 500,
          },
        );
      } catch (error) {
        app.log.warn({ error, exportJobId: job.id }, 'Export queue unavailable; outbox will retry');
      }
      await writeAudit(request, {
        action: 'export.create',
        entityType: 'export',
        entityId: job.id,
        ...(job.eventId ? { eventId: job.eventId } : {}),
        metadata: {
          kind: job.kind,
          scope: job.scope,
          replacedExports: replaced.invalidatedExports,
          cleanupPending: replaced.cleanupPending,
        },
      });
      return reply.code(202).send(serializeExportJob(job));
    },
  );

  app.get(
    '/admin/exports',
    { preHandler: readGuards, schema: { tags: ['admin', 'exports'] } },
    async (request) => {
      const { eventId, scope } = z
        .object({
          eventId: z.uuid().optional(),
          scope: z.enum(['event', 'quick_answers', 'users']).optional(),
        })
        .parse(request.query);
      const rows = await app.db
        .select()
        .from(exportJobs)
        .where(
          and(
            eventId ? eq(exportJobs.eventId, eventId) : undefined,
            scope ? eq(exportJobs.scope, scope) : undefined,
          ),
        )
        .orderBy(desc(exportJobs.createdAt))
        .limit(100);
      return { items: rows.map(serializeExportJob) };
    },
  );

  app.get(
    '/admin/exports/:exportId',
    { preHandler: readGuards, schema: { tags: ['admin', 'exports'] } },
    async (request) => {
      const { exportId } = request.params as { exportId: string };
      const [job] = await app.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.id, exportId))
        .limit(1);
      if (!job) throw new AppError('EXPORT_NOT_FOUND', 'Экспорт не найден', 404);
      return serializeExportJob(job);
    },
  );

  app.get(
    '/admin/exports/:exportId/download',
    { preHandler: readGuards, schema: { tags: ['admin', 'exports'] } },
    async (request) => {
      const { exportId } = request.params as { exportId: string };
      const [job] = await app.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.id, exportId))
        .limit(1);
      if (!job) throw new AppError('EXPORT_NOT_FOUND', 'Экспорт не найден', 404);
      if (job.status !== 'ready' || !job.bucket || !job.objectKey) {
        throw new AppError('EXPORT_NOT_READY', 'Выгрузка ещё не готова', 409);
      }
      if (job.expiresAt && job.expiresAt < new Date()) {
        throw new AppError('EXPORT_EXPIRED', 'Срок хранения выгрузки истёк', 410);
      }
      const extension = job.kind === 'zip' ? 'zip' : job.kind;
      const url = await getSignedUrl(
        app.s3,
        new GetObjectCommand({
          Bucket: job.bucket,
          Key: job.objectKey,
          ResponseContentDisposition: `attachment; filename="${job.scope}-export-${job.id}.${extension}"`,
        }),
        { expiresIn: app.config.PRESIGNED_URL_TTL_SECONDS },
      );
      return {
        url: publicStorageUrl(url, app.config.S3_PUBLIC_BASE),
        expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS,
      };
    },
  );

  app.get(
    '/admin/events/:eventId/storage',
    { preHandler: readGuards, schema: { tags: ['admin', 'events'] } },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const rows = await app.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.eventId, eventId), isNull(artifacts.deletedAt)));
      return {
        files: rows.length,
        bytes: rows.reduce(
          (total, artifact) => total + Number(artifact.actualSizeBytes ?? artifact.sizeBytes),
          0,
        ),
      };
    },
  );
};
