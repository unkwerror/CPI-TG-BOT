import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { invalidateEventExports } from './export-storage';

describe('export storage invalidation', () => {
  it('expires an old export and removes its exact stored object', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              id: 'export-id',
              kind: 'zip',
              bucket: 'exports',
              objectKey: 'event-id/export-id.zip',
            },
          ]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: 'export-id' }]),
              then: (resolve: (value: unknown[]) => void) => resolve([]),
            })),
          };
        }),
      })),
    };
    const deleted: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DeleteObjectsCommand) {
        deleted.push(
          ...(command.input.Delete?.Objects ?? []).map(
            (object) => `${command.input.Bucket}:${object.Key}`,
          ),
        );
        return {};
      }
      throw new Error('Unexpected S3 command');
    });
    const app = {
      db,
      s3Internal: { send } as unknown as S3Client,
      config: { S3_EXPORT_BUCKET: 'exports' },
      log: { warn: vi.fn() },
    };

    await expect(
      invalidateEventExports(app as never, 'event-id', 'Заменена новой выгрузкой', 'zip'),
    ).resolves.toEqual({
      invalidatedExports: 1,
      deletedObjects: 1,
      abortedMultipartUploads: 0,
      cleanupPending: false,
    });
    expect(deleted).toEqual(['exports:event-id/export-id.zip']);
    expect(updates).toEqual([
      expect.objectContaining({
        status: 'expired',
        errorMessage: 'Заменена новой выгрузкой',
      }),
      { bucket: null, objectKey: null, sizeBytes: null },
    ]);
  });
});
