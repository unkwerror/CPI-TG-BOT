import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  artifactSourceCleanupTarget,
  deleteArtifactSourceObject,
  notificationOutboxTypes,
} from './outbox';

describe('wallet outbox routing', () => {
  it('notifies only user-facing reward/store states', () => {
    expect(notificationOutboxTypes.has('reward.artifact.granted')).toBe(true);
    expect(notificationOutboxTypes.has('store.order.paid')).toBe(true);
    expect(notificationOutboxTypes.has('store.order.ready_for_pickup')).toBe(true);
    expect(notificationOutboxTypes.has('store.order.fulfilled')).toBe(true);
    expect(notificationOutboxTypes.has('reward.artifact.evaluate')).toBe(false);
    expect(notificationOutboxTypes.has('artifact.source.cleanup')).toBe(false);
  });

  it('requires the persisted source bucket and key for durable artifact cleanup', () => {
    expect(
      artifactSourceCleanupTarget({ bucket: 'legacy', objectKey: 'incoming/artifact-id' }),
    ).toEqual({ bucket: 'legacy', objectKey: 'incoming/artifact-id' });
    expect(() => artifactSourceCleanupTarget({ bucket: '', objectKey: 'incoming/file' })).toThrow(
      'Invalid artifact.source.cleanup payload',
    );
  });

  it('deletes the source from the bucket persisted in the durable event', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(DeleteObjectCommand);
      expect((command as DeleteObjectCommand).input).toEqual({
        Bucket: 'legacy',
        Key: 'incoming/artifact-id',
      });
      return {};
    });
    await deleteArtifactSourceObject({ send } as unknown as S3Client, {
      bucket: 'legacy',
      objectKey: 'incoming/artifact-id',
    });
    expect(send).toHaveBeenCalledOnce();
  });
});
