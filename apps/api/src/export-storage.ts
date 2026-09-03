import type { FastifyPluginAsync } from 'fastify';
import { and, eq, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { exportJobs } from '@cpi/db';
import { exportObjectKey, type ExportKind } from '@cpi/shared';
import { purgeStoredObjects, type EventStoragePurgeResult } from './event-storage';

export interface ExportInvalidationResult extends EventStoragePurgeResult {
  invalidatedExports: number;
  cleanupPending: boolean;
}

export async function invalidateEventExports(
  app: Parameters<FastifyPluginAsync>[0],
  eventId: string,
  reason: string,
  kind?: ExportKind,
): Promise<ExportInvalidationResult> {
  const jobs = await app.db
    .select({
      id: exportJobs.id,
      kind: exportJobs.kind,
      bucket: exportJobs.bucket,
      objectKey: exportJobs.objectKey,
    })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.eventId, eventId),
        kind ? eq(exportJobs.kind, kind) : undefined,
        or(
          ne(exportJobs.status, 'expired'),
          isNotNull(exportJobs.bucket),
          isNotNull(exportJobs.objectKey),
        ),
      ),
    );
  if (jobs.length === 0) {
    return {
      invalidatedExports: 0,
      deletedObjects: 0,
      abortedMultipartUploads: 0,
      cleanupPending: false,
    };
  }

  const expiredAt = new Date();
  const invalidated = await app.db
    .update(exportJobs)
    .set({ status: 'expired', expiresAt: expiredAt, errorMessage: reason })
    .where(
      inArray(
        exportJobs.id,
        jobs.map((job) => job.id),
      ),
    )
    .returning({ id: exportJobs.id });

  let purgeResult: EventStoragePurgeResult;
  try {
    purgeResult = await purgeStoredObjects(
      app.s3,
      jobs.flatMap((job) => {
        const generated = {
          bucket: app.config.S3_BUCKET,
          key: exportObjectKey(app.config.S3_PREFIX, {
            eventId,
            exportJobId: job.id,
            kind: job.kind,
          }),
        };
        if (!job.objectKey) return [generated];
        if (!job.bucket) {
          throw new Error(`Export ${job.id} has object_key without its persisted bucket`);
        }
        return [generated, { bucket: job.bucket, key: job.objectKey }];
      }),
    );
  } catch (error) {
    app.log.warn({ error, eventId, kind }, 'Invalidated export storage cleanup deferred');
    return {
      invalidatedExports: invalidated.length,
      deletedObjects: 0,
      abortedMultipartUploads: 0,
      cleanupPending: true,
    };
  }
  await app.db
    .update(exportJobs)
    .set({ bucket: null, objectKey: null, sizeBytes: null })
    .where(
      inArray(
        exportJobs.id,
        jobs.map((job) => job.id),
      ),
    );
  return { invalidatedExports: invalidated.length, ...purgeResult, cleanupPending: false };
}
