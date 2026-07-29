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
