import { AbortMultipartUploadCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerContext } from './context';
import { runMaintenance } from './maintenance';

function maintenanceContext(selections: unknown[][], send: (command: unknown) => Promise<unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selections.shift() ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return { where: vi.fn(async () => []) };
      }),
    })),
  };
  const context = {
    config: {
      ABANDONED_UPLOAD_HOURS: 1,
      DELETED_OBJECT_RETENTION_DAYS: 0,
      S3_QUARANTINE_BUCKET: 'quarantine',
      S3_PRIVATE_BUCKET: 'private',
    },
    db,
    s3: { send: vi.fn(send) },
    logger: { warn: vi.fn() },
  } as unknown as WorkerContext;
  return { context, updates };
}

describe('storage maintenance', () => {
  it('physically clears deleted artifacts and expired exports only once', async () => {
    const deletedKeys: string[] = [];
    const artifact = {
      id: 'artifact-id',
      bucket: 'private',
      objectKey: 'event/submission/artifact',
      uploadId: null,
    };
    const exportJob = {
      id: 'export-id',
      bucket: 'exports',
      objectKey: 'event/export.zip',
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
    });
    expect(deletedKeys).toEqual([
      'private:event/submission/artifact',
      'quarantine:event/submission/artifact',
      'exports:event/export.zip',
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
      bucket: 'quarantine',
      objectKey: 'event/submission/artifact',
      uploadId: 'completed-upload',
    };
    const { context } = maintenanceContext([[artifact], [], []], async (command) => {
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
    });
  });
});
