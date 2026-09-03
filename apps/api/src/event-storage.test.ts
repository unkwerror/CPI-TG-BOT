import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { purgeArtifactStorage, purgeEventStorage, purgeStoredObjects } from './event-storage';

describe('event storage purge', () => {
  it('aborts multipart uploads and deletes every object under the given prefixes', async () => {
    const listedMultipart = new Set<string>();
    const listedObjects = new Set<string>();
    const aborted: string[] = [];
    const deleted: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListMultipartUploadsCommand) {
        const prefix = command.input.Prefix!;
        expect(command.input.Bucket).toBe('shared');
        if (listedMultipart.has(prefix)) return { Uploads: [] };
        listedMultipart.add(prefix);
        return { Uploads: [{ Key: `${prefix}incomplete`, UploadId: `${prefix}upload` }] };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        aborted.push(String(command.input.UploadId));
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix!;
        if (listedObjects.has(prefix)) return { Contents: [] };
        listedObjects.add(prefix);
        return { Contents: [{ Key: `${prefix}one` }, { Key: `${prefix}two` }] };
      }
      if (command instanceof DeleteObjectsCommand) {
        deleted.push(...(command.input.Delete?.Objects ?? []).map((object) => String(object.Key)));
        return {};
      }
      throw new Error('Unexpected S3 command');
    });

    const result = await purgeEventStorage({ send } as unknown as S3Client, 'shared', [
      'locker/incoming/event-id/',
      'locker/exports/event-id/',
      'locker/incoming/event-id/',
    ]);

    expect(result).toEqual({ deletedObjects: 4, abortedMultipartUploads: 2 });
    expect(aborted).toEqual(['locker/incoming/event-id/upload', 'locker/exports/event-id/upload']);
    expect(deleted).toEqual([
      'locker/incoming/event-id/one',
      'locker/incoming/event-id/two',
      'locker/exports/event-id/one',
      'locker/exports/event-id/two',
    ]);
  });

  it('fails instead of reporting success when object storage rejects a deletion', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListMultipartUploadsCommand) return { Uploads: [] };
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'locker/incoming/event-id/file' }] };
      }
      if (command instanceof DeleteObjectsCommand) {
        return { Errors: [{ Key: 'locker/incoming/event-id/file', Code: 'AccessDenied' }] };
      }
      throw new Error('Unexpected S3 command');
    });

    await expect(
      purgeEventStorage({ send } as unknown as S3Client, 'shared', ['locker/incoming/event-id/']),
    ).rejects.toThrow('AccessDenied');
  });

  it('aborts known uploads and deletes exact objects without duplicating requests', async () => {
    const aborted: string[] = [];
    const deleted: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof AbortMultipartUploadCommand) {
        aborted.push(`${command.input.Key}:${command.input.UploadId}`);
        return {};
      }
      if (command instanceof DeleteObjectsCommand) {
        deleted.push(...(command.input.Delete?.Objects ?? []).map((object) => String(object.Key)));
        return {};
      }
      throw new Error('Unexpected S3 command');
    });

    const result = await purgeStoredObjects({ send } as unknown as S3Client, [
      { bucket: 'shared', key: 'locker/artifacts/Событие/Иванов/Устав.pdf' },
      {
        bucket: 'legacy',
        key: 'locker/incoming/event/submission/artifact',
        uploadId: 'multipart-id',
      },
      {
        bucket: 'legacy',
        key: 'locker/incoming/event/submission/artifact',
        uploadId: 'multipart-id',
      },
      { bucket: 'shared', key: 'locker/exports/event/export.zip' },
    ]);

    expect(result).toEqual({ deletedObjects: 3, abortedMultipartUploads: 1 });
    expect(aborted).toEqual(['locker/incoming/event/submission/artifact:multipart-id']);
    expect(deleted).toEqual([
      'locker/artifacts/Событие/Иванов/Устав.pdf',
      'locker/exports/event/export.zip',
      'locker/incoming/event/submission/artifact',
    ]);
  });

  it('treats an already absent multipart upload as successfully cleaned up', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof AbortMultipartUploadCommand) {
        throw Object.assign(new Error('missing'), { name: 'NoSuchUpload' });
      }
      if (command instanceof DeleteObjectsCommand) return {};
      throw new Error('Unexpected S3 command');
    });

    await expect(
      purgeStoredObjects({ send } as unknown as S3Client, [
        { bucket: 'legacy', key: 'locker/incoming/event/file', uploadId: 'already-gone' },
      ]),
    ).resolves.toEqual({ deletedObjects: 1, abortedMultipartUploads: 0 });
  });

  it('deletes an artifact by the key recorded in the database', async () => {
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

    await purgeArtifactStorage({ send } as unknown as S3Client, [
      { bucket: 'legacy', objectKey: 'locker/artifacts/Событие/Иванов/Устав.pdf' },
    ]);

    expect(deleted).toEqual(['legacy:locker/artifacts/Событие/Иванов/Устав.pdf']);
  });
});
