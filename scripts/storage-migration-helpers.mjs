/* global Buffer */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

function copySource(bucket, key) {
  return `${bucket}/${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

export function createHashingBody(body, state) {
  return Readable.from(
    (async function* () {
      const hash = createHash('sha256');
      for await (const rawChunk of body) {
        const chunk = Buffer.from(rawChunk);
        hash.update(chunk);
        state.sizeBytes += chunk.length;
        yield chunk;
      }
      state.checksumSha256 = hash.digest('hex');
    })(),
  );
}

export function assertMigratedHead(head, expected) {
  if (
    Number(head.ContentLength ?? -1) !== expected.sizeBytes ||
    head.ContentType !== expected.mimeType ||
    head.Metadata?.artifact !== expected.artifactId ||
    head.Metadata?.submission !== expected.submissionId ||
    head.Metadata?.sha256 !== expected.checksumSha256
  ) {
    throw new Error(`Migrated object verification failed for ${expected.artifactId}`);
  }
}

export async function copyObjectStreaming({
  source,
  target,
  targetBucket,
  row,
  destinationKey,
  dryRun,
}) {
  const expectedSize = Number(row.actual_size_bytes ?? row.size_bytes);
  const sourceHead = await source.send(
    new HeadObjectCommand({ Bucket: row.bucket, Key: row.object_key }),
  );
  if (Number(sourceHead.ContentLength ?? -1) !== expectedSize) {
    throw new Error(
      `Size mismatch for ${row.id}: source HEAD has ${String(sourceHead.ContentLength)}, database has ${expectedSize}`,
    );
  }
  const object = await source.send(
    new GetObjectCommand({ Bucket: row.bucket, Key: row.object_key }),
  );
  if (!object.Body || !(Symbol.asyncIterator in object.Body)) {
    throw new Error(`Non-streamable body for ${row.id}`);
  }

  const state = { sizeBytes: 0, checksumSha256: null };
  const body = createHashingBody(object.Body, state);
  let targetCreated = false;
  try {
    if (dryRun) {
      for await (const chunk of body) {
        // Drain the source through the same hashing path without retaining file bytes.
        void chunk;
      }
    } else {
      const upload = new Upload({
        client: target,
        params: {
          Bucket: targetBucket,
          Key: destinationKey,
          Body: body,
          ContentType: row.mime_type,
          Metadata: {
            artifact: row.id,
            submission: row.submission_id,
            sha256: row.checksum_sha256 ?? 'pending',
            migrated: 'minio-to-beget',
          },
        },
        queueSize: 2,
        partSize: 10 * 1024 ** 2,
        leavePartsOnError: false,
      });
      await upload.done();
      targetCreated = true;
    }

    const checksumSha256 = state.checksumSha256;
    if (!checksumSha256) throw new Error(`Checksum was not calculated for ${row.id}`);
    if (state.sizeBytes !== expectedSize) {
      throw new Error(
        `Size mismatch for ${row.id}: source has ${state.sizeBytes}, database has ${expectedSize}`,
      );
    }
    if (row.checksum_sha256 && row.checksum_sha256 !== checksumSha256) {
      throw new Error(`Checksum mismatch for ${row.id}`);
    }

    if (!dryRun) {
      // The checksum is only known after streaming. A server-side self-copy replaces temporary
      // metadata without buffering or downloading the object again.
      await target.send(
        new CopyObjectCommand({
          Bucket: targetBucket,
          Key: destinationKey,
          CopySource: copySource(targetBucket, destinationKey),
          ContentType: row.mime_type,
          MetadataDirective: 'REPLACE',
          Metadata: {
            artifact: row.id,
            submission: row.submission_id,
            sha256: checksumSha256,
            migrated: 'minio-to-beget',
          },
        }),
      );
      const head = await target.send(
        new HeadObjectCommand({ Bucket: targetBucket, Key: destinationKey }),
      );
      assertMigratedHead(head, {
        sizeBytes: state.sizeBytes,
        artifactId: row.id,
        submissionId: row.submission_id,
        checksumSha256,
        mimeType: row.mime_type,
      });
      return { checksumSha256, sizeBytes: state.sizeBytes, etag: head.ETag ?? null };
    }
    return { checksumSha256, sizeBytes: state.sizeBytes, etag: null };
  } catch (error) {
    if (targetCreated) {
      try {
        await target.send(new DeleteObjectCommand({ Bucket: targetBucket, Key: destinationKey }));
      } catch {
        // Preserve the validation error. A rerun sees the orphan and won't overwrite it blindly.
      }
    }
    throw error;
  }
}
