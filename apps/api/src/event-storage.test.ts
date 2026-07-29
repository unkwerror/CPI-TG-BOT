import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { purgeEventStorage } from './event-storage';

describe('event storage purge', () => {
  it('aborts multipart uploads and deletes every object under the exact event prefix', async () => {
    const listedMultipart = new Set<string>();
    const listedObjects = new Set<string>();
    const aborted: string[] = [];
    const deleted: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListMultipartUploadsCommand) {
        const bucket = command.input.Bucket!;
        expect(command.input.Prefix).toBe('event-id/');
        if (listedMultipart.has(bucket)) return { Uploads: [] };
        listedMultipart.add(bucket);
        return { Uploads: [{ Key: 'event-id/incomplete', UploadId: `${bucket}-upload` }] };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        aborted.push(`${command.input.Bucket}:${command.input.UploadId}`);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const bucket = command.input.Bucket!;
        expect(command.input.Prefix).toBe('event-id/');
        if (listedObjects.has(bucket)) return { Contents: [] };
        listedObjects.add(bucket);
        return {
          Contents: [{ Key: 'event-id/one' }, { Key: 'event-id/two' }],
        };
      }
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

    const result = await purgeEventStorage(
      { send } as unknown as S3Client,
      ['private', 'quarantine', 'private'],
      'event-id',
    );

    expect(result).toEqual({ deletedObjects: 4, abortedMultipartUploads: 2 });
    expect(aborted).toEqual(['private:private-upload', 'quarantine:quarantine-upload']);
    expect(deleted).toEqual([
      'private:event-id/one',
      'private:event-id/two',
      'quarantine:event-id/one',
      'quarantine:event-id/two',
    ]);
  });

  it('fails instead of reporting success when object storage rejects a deletion', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListMultipartUploadsCommand) return { Uploads: [] };
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'event-id/file' }] };
      }
      if (command instanceof DeleteObjectsCommand) {
        return { Errors: [{ Key: 'event-id/file', Code: 'AccessDenied' }] };
      }
      throw new Error('Unexpected S3 command');
    });

    await expect(
      purgeEventStorage({ send } as unknown as S3Client, ['private'], 'event-id'),
    ).rejects.toThrow('AccessDenied');
  });
});
