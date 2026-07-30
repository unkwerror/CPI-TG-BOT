import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';

export interface EventStoragePurgeResult {
  deletedObjects: number;
  abortedMultipartUploads: number;
}

export interface StoredObjectTarget {
  bucket: string;
  key: string;
  uploadId?: string | null;
}

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

export async function purgeStoredObjects(
  s3: S3Client,
  targets: Iterable<StoredObjectTarget>,
): Promise<EventStoragePurgeResult> {
  const objectsByBucket = new Map<string, Set<string>>();
  const multipartUploads = new Map<string, { bucket: string; key: string; uploadId: string }>();

  for (const target of targets) {
    const keys = objectsByBucket.get(target.bucket) ?? new Set<string>();
    keys.add(target.key);
    objectsByBucket.set(target.bucket, keys);
    if (target.uploadId) {
      multipartUploads.set(`${target.bucket}\0${target.key}\0${target.uploadId}`, {
        bucket: target.bucket,
        key: target.key,
        uploadId: target.uploadId,
      });
    }
  }

  let abortedMultipartUploads = 0;
  const uploads = [...multipartUploads.values()];
  for (let index = 0; index < uploads.length; index += 20) {
    await Promise.all(
      uploads.slice(index, index + 20).map(async (target) => {
        try {
          await s3.send(
            new AbortMultipartUploadCommand({
              Bucket: target.bucket,
              Key: target.key,
              UploadId: target.uploadId,
            }),
          );
          abortedMultipartUploads += 1;
        } catch (error) {
          if (!isMissingMultipartUpload(error)) throw error;
        }
      }),
    );
  }

  let deletedObjects = 0;
  for (const [bucket, keys] of objectsByBucket) {
    const objects = [...keys];
    for (let index = 0; index < objects.length; index += 1_000) {
      const batch = objects.slice(index, index + 1_000);
      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      if (result.Errors?.length) {
        const first = result.Errors[0];
        throw new Error(
          `S3 failed to delete ${result.Errors.length} stored objects; first error: ${first?.Code ?? 'unknown'}`,
        );
      }
      deletedObjects += batch.length;
    }
  }

  return { deletedObjects, abortedMultipartUploads };
}

async function abortMultipartUploads(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<number> {
  let aborted = 0;
  for (;;) {
    const page = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix,
        MaxUploads: 100,
      }),
    );
    const uploads = (page.Uploads ?? []).filter(
      (upload): upload is { Key: string; UploadId: string } =>
        Boolean(upload.Key && upload.UploadId),
    );
    if (uploads.length === 0) return aborted;
    for (let index = 0; index < uploads.length; index += 20) {
      await Promise.all(
        uploads.slice(index, index + 20).map((upload) =>
          s3.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          ),
        ),
      );
    }
    aborted += uploads.length;
  }
}

async function deleteStoredObjects(s3: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1_000,
      }),
    );
    const objects = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key));
    if (objects.length === 0) return deleted;
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: objects.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    if (result.Errors?.length) {
      const first = result.Errors[0];
      throw new Error(
        `S3 failed to delete ${result.Errors.length} event objects; first error: ${first?.Code ?? 'unknown'}`,
      );
    }
    deleted += objects.length;
  }
}

export async function purgeEventStorage(
  s3: S3Client,
  buckets: Iterable<string>,
  eventId: string,
): Promise<EventStoragePurgeResult> {
  const prefix = `${eventId}/`;
  let deletedObjects = 0;
  let abortedMultipartUploads = 0;
  for (const bucket of new Set(buckets)) {
    abortedMultipartUploads += await abortMultipartUploads(s3, bucket, prefix);
    deletedObjects += await deleteStoredObjects(s3, bucket, prefix);
  }
  return { deletedObjects, abortedMultipartUploads };
}
