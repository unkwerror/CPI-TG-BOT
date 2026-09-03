import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerContext } from './context';
import { runMaintenance } from './maintenance';

function maintenanceContext(selections: unknown[][], send: (command: unknown) => Promise<unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const db: Record<string, unknown> = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const limit = vi.fn(async () => selections.shift() ?? []);
          return { limit, for: vi.fn(() => ({ limit })) };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return { where: vi.fn(async () => []) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return { onConflictDoNothing: vi.fn(async () => []) };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
    execute: vi.fn(async () => []),
  };
  db.transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
    callback(db),
  );
  const context = {
    config: {
      ABANDONED_UPLOAD_HOURS: 1,
      DELETED_OBJECT_RETENTION_DAYS: 0,
      S3_BUCKET: 'shared',
    },
    db,
    s3: { send: vi.fn(send) },
    logger: { warn: vi.fn() },
  } as unknown as WorkerContext;
  return { context, updates, inserted };
}

describe('storage maintenance', () => {
  it('physically clears deleted artifacts and expired exports only once', async () => {
    const deletedKeys: string[] = [];
    const artifact = {
      id: 'artifact-id',
      submissionId: 'submission-id',
      status: 'uploading',
      sizeBytes: 42,
      bucket: 'shared',
      objectKey: 'locker/artifacts/Событие/Иванов/Устав.pdf',
      uploadId: null,
    };
    const exportJob = {
      id: 'export-id',
      bucket: 'legacy',
      objectKey: 'locker/exports/event/export.zip',
    };
    const { context, updates } = maintenanceContext(
      [[], [artifact], [exportJob]],
      async (command) => {
        if (command instanceof DeleteObjectCommand) {
          deletedKeys.push(`${command.input.Bucket}:${command.input.Key}`);
          return {};
        }
        throw new Error('Unexpected S3 command');
      },
    );

    await expect(runMaintenance(context)).resolves.toEqual({
      abandonedUploads: 0,
      deletedObjects: 1,
      expiredExports: 1,
      abandonedProductMedia: 0,
    });
    expect(deletedKeys).toEqual([
      'shared:locker/artifacts/Событие/Иванов/Устав.pdf',
      'legacy:locker/exports/event/export.zip',
    ]);
    expect(updates[0]).toMatchObject({ uploadId: null });
    expect(updates[0]?.storageDeletedAt).toBeInstanceOf(Date);
    expect(updates[1]).toMatchObject({
      status: 'expired',
      bucket: null,
      objectKey: null,
      sizeBytes: null,
    });
  });

  it('continues cleanup when a completed multipart upload no longer exists', async () => {
    const artifact = {
      id: 'artifact-id',
      submissionId: 'submission-id',
      status: 'uploading',
      sizeBytes: 42,
      bucket: 'shared',
      objectKey: 'locker/incoming/event/submission/artifact',
      uploadId: 'completed-upload',
    };
    const { context } = maintenanceContext([[artifact], [artifact], [], []], async (command) => {
      if (command instanceof HeadObjectCommand) {
        throw Object.assign(new Error('missing'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        });
      }
      if (command instanceof AbortMultipartUploadCommand) {
        throw Object.assign(new Error('missing'), { name: 'NoSuchUpload' });
      }
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error('Unexpected S3 command');
    });

    await expect(runMaintenance(context)).resolves.toEqual({
      abandonedUploads: 1,
      deletedObjects: 0,
      expiredExports: 0,
      abandonedProductMedia: 0,
    });
  });

  it('recovers an object completed in S3 before the database status commit', async () => {
    const artifact = {
      id: 'artifact-id',
      submissionId: 'submission-id',
      status: 'uploading',
      sizeBytes: 42,
      bucket: 'beget-bucket',
      objectKey: 'locker/incoming/event/submission/artifact',
      uploadId: 'already-completed-upload',
    };
    const { context, updates, inserted } = maintenanceContext(
      [[artifact], [artifact], [], []],
      async (command) => {
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: 42,
            ETag: 'etag',
            Metadata: { artifact: 'artifact-id', submission: 'submission-id' },
          };
        }
        throw new Error('Recovery must not delete a valid object');
      },
    );

    await expect(runMaintenance(context)).resolves.toEqual({
      abandonedUploads: 0,
      deletedObjects: 0,
      expiredExports: 0,
      abandonedProductMedia: 0,
    });
    expect(updates[0]).toMatchObject({ status: 'uploaded', uploadId: null, etag: 'etag' });
    expect(inserted).toContainEqual({
      type: 'artifact.uploaded',
      aggregateType: 'artifact',
      aggregateId: 'artifact-id',
      payload: { artifactId: 'artifact-id' },
    });
  });

  it('removes expired pending product images and their stored objects', async () => {
    const media = {
      id: 'media-id',
      bucket: 'shared',
      objectKey: 'locker/store/products/product/media.png',
      uploadStatus: 'pending',
    };
    const deletedKeys: string[] = [];
    const { context } = maintenanceContext([[], [], [], [media]], async (command) => {
      if (command instanceof DeleteObjectCommand) {
        deletedKeys.push(`${command.input.Bucket}:${command.input.Key}`);
        return {};
      }
      throw new Error('Unexpected S3 command');
    });

    await expect(runMaintenance(context)).resolves.toEqual({
      abandonedUploads: 0,
      deletedObjects: 0,
      expiredExports: 0,
      abandonedProductMedia: 1,
    });
    expect(deletedKeys).toEqual(['shared:locker/store/products/product/media.png']);
  });
});
