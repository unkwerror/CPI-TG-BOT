import { AbortMultipartUploadCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { artifacts, exportJobs } from '@cpi/db';
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
  await Promise.all(
    [
      ...new Set([
        artifact.bucket,
        context.config.S3_QUARANTINE_BUCKET,
        context.config.S3_PRIVATE_BUCKET,
      ]),
    ].map((bucket) =>
      context.s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: artifact.objectKey,
        }),
      ),
    ),
  );
}

export async function runMaintenance(context: WorkerContext): Promise<{
  abandonedUploads: number;
  deletedObjects: number;
  expiredExports: number;
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
      await deleteArtifactObject(context, artifact);
    } catch (error) {
      context.logger.warn({ error, artifactId: artifact.id }, 'Abandoned S3 upload cleanup failed');
      continue;
    }
    await context.db
      .update(artifacts)
      .set({
        status: 'failed',
        statusReason: 'Истёк срок незавершённой загрузки',
        uploadId: null,
        storageDeletedAt: new Date(),
      })
      .where(eq(artifacts.id, artifact.id));
    abandonedUploads += 1;
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

  return { abandonedUploads, deletedObjects, expiredExports };
}
