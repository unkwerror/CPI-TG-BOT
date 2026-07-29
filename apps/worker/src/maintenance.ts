import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { artifacts, exportJobs } from '@cpi/db';
import type { WorkerContext } from './context';

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
      if (artifact.uploadId) {
        await context.s3.send(
          new AbortMultipartUploadCommand({
            Bucket: artifact.bucket,
            Key: artifact.objectKey,
            UploadId: artifact.uploadId,
          }),
        );
      } else {
        await context.s3.send(
          new DeleteObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
        );
      }
    } catch (error) {
      context.logger.warn({ error, artifactId: artifact.id }, 'Abandoned S3 upload cleanup failed');
    }
    await context.db
      .update(artifacts)
      .set({ status: 'failed', statusReason: 'Истёк срок незавершённой загрузки' })
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
        lt(artifacts.deletedAt, deletionBefore),
      ),
    )
    .limit(500);
  let deletedObjects = 0;
  for (const artifact of deleted) {
    try {
      await context.s3.send(
        new DeleteObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
      );
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
        eq(exportJobs.status, 'ready'),
        isNotNull(exportJobs.expiresAt),
        lt(exportJobs.expiresAt, new Date()),
        isNotNull(exportJobs.bucket),
        isNotNull(exportJobs.objectKey),
      ),
    )
    .limit(100);
  let expiredExports = 0;
  for (const job of expired) {
    try {
      await context.s3.send(
        new DeleteObjectCommand({ Bucket: job.bucket!, Key: job.objectKey! }),
      );
      await context.db
        .update(exportJobs)
        .set({ status: 'expired', bucket: null, objectKey: null })
        .where(eq(exportJobs.id, job.id));
      expiredExports += 1;
    } catch (error) {
      context.logger.warn({ error, exportJobId: job.id }, 'Expired export cleanup failed');
    }
  }

  return { abandonedUploads, deletedObjects, expiredExports };
}
