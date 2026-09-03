import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  assertFeedCoverHead,
  deleteFeedCoverObject,
  feedCoverObjectKey,
  feedCoverPutHeaders,
  serializeFeedCoverUrl,
} from './feed-cover';

const pending = {
  uploadId: '11111111-1111-4111-8111-111111111111',
  postId: '22222222-2222-4222-8222-222222222222',
  bucket: 'artifacts',
  objectKey:
    'locker/feed/posts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.png',
  contentType: 'image/png' as const,
  sizeBytes: 1234,
};

describe('feed cover storage', () => {
  it('builds an isolated Beget S3 key and signed PUT headers', () => {
    expect(
      feedCoverObjectKey('locker/', pending.postId, pending.uploadId, pending.contentType),
    ).toBe(pending.objectKey);
    expect(
      feedCoverPutHeaders(pending.uploadId, pending.postId, pending.contentType, pending.sizeBytes),
    ).toEqual({
      'content-type': 'image/png',
      'x-amz-meta-upload-id': pending.uploadId,
      'x-amz-meta-feed-post-id': pending.postId,
      'x-amz-meta-expected-size': '1234',
    });
  });

  it('rejects an object whose Beget metadata does not match the upload grant', () => {
    expect(() =>
      assertFeedCoverHead(pending, {
        $metadata: {},
        ContentLength: pending.sizeBytes,
        ContentType: pending.contentType,
        Metadata: {
          'upload-id': pending.uploadId,
          'feed-post-id': 'another-post',
          'expected-size': String(pending.sizeBytes),
        },
      }),
    ).toThrow(/не соответствует/);
  });

  it('accepts identical metadata values joined by the Beget reverse proxy', () => {
    expect(() =>
      assertFeedCoverHead(pending, {
        $metadata: {},
        ContentLength: pending.sizeBytes,
        ContentType: pending.contentType,
        Metadata: {
          'upload-id': `${pending.uploadId},${pending.uploadId}`,
          'feed-post-id': `${pending.postId},${pending.postId}`,
          'expected-size': `${pending.sizeBytes},${pending.sizeBytes}`,
        },
      }),
    ).not.toThrow();
  });

  it('keeps legacy URLs and signs stored private covers for reads', async () => {
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: 'https://s3.example.test',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret-secret' },
      forcePathStyle: true,
    });
    expect(
      await serializeFeedCoverUrl(
        s3,
        { S3_PUBLIC_BASE: '', PRESIGNED_URL_TTL_SECONDS: 900 },
        {
          coverUrl: 'https://legacy.example.test/cover.jpg',
          coverBucket: null,
          coverObjectKey: null,
          coverContentType: null,
        },
      ),
    ).toBe('https://legacy.example.test/cover.jpg');
    const url = await serializeFeedCoverUrl(
      s3,
      {
        S3_PUBLIC_BASE: 'https://app.example.test/storage',
        PRESIGNED_URL_TTL_SECONDS: 900,
      },
      {
        coverUrl: null,
        coverBucket: pending.bucket,
        coverObjectKey: pending.objectKey,
        coverContentType: pending.contentType,
      },
    );
    expect(url).toContain('https://app.example.test/storage/');
    expect(url).toContain('X-Amz-Signature=');
  });

  it('deletes a replaced cover and tolerates an already missing object', async () => {
    const send = vi.fn().mockRejectedValueOnce({ name: 'NoSuchKey' });
    const s3 = { send } as unknown as S3Client;
    await expect(
      deleteFeedCoverObject(s3, {
        coverBucket: pending.bucket,
        coverObjectKey: pending.objectKey,
      }),
    ).resolves.toBeUndefined();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('creates signed read requests as GetObject operations', async () => {
    const send = vi.fn();
    const s3 = { send } as unknown as S3Client;
    await deleteFeedCoverObject(s3, {
      coverBucket: null,
      coverObjectKey: null,
    });
    expect(send).not.toHaveBeenCalled();
    expect(new GetObjectCommand({ Bucket: pending.bucket, Key: pending.objectKey })).toBeInstanceOf(
      GetObjectCommand,
    );
  });
});
