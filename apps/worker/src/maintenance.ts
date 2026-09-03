import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { artifacts, exportJobs, outboxEvents, storeProductMedia } from '@cpi/db';
import { deleteProductMediaObject } from '../../api/src/product-media';
import type { WorkerContext } from './context';

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

async function deleteArtifactObject(
  context: WorkerContext,
  artifact: typeof artifacts.$inferSelect,
): Promise<void> {
  if (artifact.uploadId) {
    try {
      await context.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: artifact.bucket,
          Key: artifact.objectKey,
          UploadId: artifact.uploadId,
        }),
      );
    } catch (error) {
      if (!isMissingMultipartUpload(error)) throw error;
    }
  }
  await context.s3.send(
    new DeleteObjectCommand({
      Bucket: artifact.bucket,
      Key: artifact.objectKey,
    }),
  );
}

export async function runMaintenance(context: WorkerContext): Promise<{
  abandonedUploads: number;
  deletedObjects: number;
  expiredExports: number;
  abandonedProductMedia: number;
}> {
  const abandonedBefore = new Date(
    Date.now() - context.config.ABANDONED_UPLOAD_HOURS * 60 * 60 * 1000,
  );
  const deletionBefore = new Date(
    Date.now() - context.config.DELETED_OBJECT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const abandoned = await context.db
    .select()
    .from(artifacts)
    .where(
      and(
        inArray(artifacts.status, ['created', 'uploading']),
        lt(artifacts.createdAt, abandonedBefore),
      ),
    )
    .limit(500);
  let abandonedUploads = 0;
  for (const artifact of abandoned) {
    try {
      const outcome = await context.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`artifact-complete:${artifact.id}`}, 0))`,
        );
        const [current] = await transaction
          .select()
          .from(artifacts)
          .where(eq(artifacts.id, artifact.id))
          .for('update')
          .limit(1);
        if (!current || !['created', 'uploading'].includes(current.status)) return 'skipped';

        let head = null;
        try {
          head = await context.s3.send(
            new HeadObjectCommand({
              Bucket: current.bucket,
              Key: current.objectKey,
            }),
          );
        } catch (error) {
          if (!isMissingMultipartUpload(error)) throw error;
        }
        if (
          head &&
          head.ContentLength === Number(current.sizeBytes) &&
          head.Metadata?.artifact === current.id &&
          head.Metadata?.submission === current.submissionId
        ) {
          await transaction
            .update(artifacts)
            .set({
              status: 'uploaded',
              statusReason: null,
              etag: head.ETag ?? null,
              uploadId: null,
            })
            .where(and(eq(artifacts.id, current.id), eq(artifacts.status, current.status)));
          await transaction
            .insert(outboxEvents)
            .values({
              type: 'artifact.uploaded',
              aggregateType: 'artifact',
              aggregateId: current.id,
              payload: { artifactId: current.id },
            })
            .onConflictDoNothing();
          return 'recovered';
        }

        await deleteArtifactObject(context, current);
        await transaction
          .update(artifacts)
          .set({
            status: 'failed',
            statusReason: 'Истёк срок незавершённой загрузки',
            uploadId: null,
            storageDeletedAt: new Date(),
          })
          .where(eq(artifacts.id, current.id));
        return 'abandoned';
      });
      if (outcome === 'abandoned') abandonedUploads += 1;
    } catch (error) {
      context.logger.warn({ error, artifactId: artifact.id }, 'Abandoned S3 upload cleanup failed');
    }
  }

  const deleted = await context.db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.status, 'deleted'),
        isNotNull(artifacts.deletedAt),
        isNull(artifacts.storageDeletedAt),
        lt(artifacts.deletedAt, deletionBefore),
      ),
    )
    .limit(500);
  let deletedObjects = 0;
  for (const artifact of deleted) {
    try {
      await deleteArtifactObject(context, artifact);
      await context.db
        .update(artifacts)
        .set({ uploadId: null, storageDeletedAt: new Date() })
        .where(eq(artifacts.id, artifact.id));
      deletedObjects += 1;
    } catch (error) {
      context.logger.warn({ error, artifactId: artifact.id }, 'Deleted object cleanup failed');
    }
  }

  const expired = await context.db
    .select()
    .from(exportJobs)
    .where(
      and(
        inArray(exportJobs.status, ['ready', 'expired']),
        or(
          eq(exportJobs.status, 'expired'),
          and(
            eq(exportJobs.status, 'ready'),
            isNotNull(exportJobs.expiresAt),
            lt(exportJobs.expiresAt, new Date()),
          ),
        ),
        isNotNull(exportJobs.bucket),
        isNotNull(exportJobs.objectKey),
      ),
    )
    .limit(100);
  let expiredExports = 0;
  for (const job of expired) {
    try {
      await context.s3.send(new DeleteObjectCommand({ Bucket: job.bucket!, Key: job.objectKey! }));
      await context.db
        .update(exportJobs)
        .set({ status: 'expired', bucket: null, objectKey: null, sizeBytes: null })
        .where(eq(exportJobs.id, job.id));
      expiredExports += 1;
    } catch (error) {
      context.logger.warn({ error, exportJobId: job.id }, 'Expired export cleanup failed');
    }
  }

  const expiredProductMedia = await context.db
    .select()
    .from(storeProductMedia)
    .where(
      and(
        eq(storeProductMedia.uploadStatus, 'pending'),
        lt(storeProductMedia.uploadExpiresAt, new Date()),
      ),
    )
    .limit(200);
  let abandonedProductMedia = 0;
  for (const media of expiredProductMedia) {
    try {
      await deleteProductMediaObject(context.s3, media);
      await context.db.delete(storeProductMedia).where(eq(storeProductMedia.id, media.id));
      abandonedProductMedia += 1;
    } catch (error) {
      context.logger.warn({ error, mediaId: media.id }, 'Expired product media cleanup failed');
    }
  }

  return { abandonedUploads, deletedObjects, expiredExports, abandonedProductMedia };
}
