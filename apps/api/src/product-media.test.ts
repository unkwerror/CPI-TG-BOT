import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@cpi/shared';
import {
  assertProductMediaHead,
  assertProductMediaSignature,
  deleteProductMediaObject,
  isMissingProductMediaObject,
  productMediaObjectKey,
  productMediaPutHeaders,
  serializeReadyProductMedia,
} from './product-media';

const pending = {
  id: '11111111-1111-4111-8111-111111111111',
  productId: '22222222-2222-4222-8222-222222222222',
  bucket: 'cpi-artifacts',
  objectKey:
    'locker/store/products/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.png',
  contentType: 'image/png',
  sizeBytes: 16,
  uploadExpiresAt: new Date('2026-08-15T09:00:00.000Z'),
};

describe('product media upload helpers', () => {
  it('keeps store objects under the locker prefix with a stable extension', () => {
    expect(productMediaObjectKey('locker/', pending.productId, pending.id, 'image/png')).toBe(
      pending.objectKey,
    );
    expect(productMediaPutHeaders(pending.id, pending.productId, 'image/png', 16)).toEqual({
      'content-type': 'image/png',
      'x-amz-meta-upload-id': pending.id,
      'x-amz-meta-product-id': pending.productId,
      'x-amz-meta-expected-size': '16',
    });
  });

  it('accepts a head object that matches the issued grant', () => {
    expect(() =>
      assertProductMediaHead(pending, {
        $metadata: {},
        ContentLength: 16,
        ContentType: 'image/png',
        Metadata: {
          'upload-id': pending.id,
          'product-id': pending.productId,
          'expected-size': '16',
        },
      }),
    ).not.toThrow();
  });

  it('rejects a swapped file or forged metadata', () => {
    expect(() =>
      assertProductMediaHead(pending, {
        $metadata: {},
        ContentLength: 16,
        ContentType: 'image/jpeg',
        Metadata: {
          'upload-id': pending.id,
          'product-id': pending.productId,
          'expected-size': '16',
        },
      }),
    ).toThrow(AppError);
    expect(() =>
      assertProductMediaHead(pending, {
        $metadata: {},
        ContentLength: 16,
        ContentType: 'image/png',
        Metadata: {
          'upload-id': 'other',
          'product-id': pending.productId,
          'expected-size': '16',
        },
      }),
    ).toThrow(/не соответствует/);
  });

  it('rejects a non-image payload that only claims to be PNG', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return {
        Body: {
          transformToByteArray: async () =>
            Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
        },
      };
    });
    await expect(assertProductMediaSignature({ send } as never, pending)).rejects.toMatchObject({
      code: 'PRODUCT_MEDIA_SIGNATURE_MISMATCH',
    });
  });

  it('serializes ready stored media through the public storage host', async () => {
    const media = {
      id: pending.id,
      productId: pending.productId,
      url: null,
      bucket: pending.bucket,
      objectKey: pending.objectKey,
      contentType: 'image/png',
      sizeBytes: 16,
      uploadStatus: 'ready' as const,
      uploadExpiresAt: null,
      altText: 'Значок',
      sortOrder: 0,
      createdAt: new Date('2026-08-15T08:00:00.000Z'),
    };
    const dto = await serializeReadyProductMedia(
      new S3Client({
        region: 'us-east-1',
        endpoint: 'https://s3.example.test',
        credentials: { accessKeyId: 'test', secretAccessKey: 'testtest' },
        forcePathStyle: true,
      }),
      {
        S3_PUBLIC_BASE: 'https://artifacts.example.org/storage',
        PRESIGNED_URL_TTL_SECONDS: 900,
      },
      media,
    );
    expect(dto).toMatchObject({
      id: pending.id,
      productId: pending.productId,
      altText: 'Значок',
    });
    expect(dto?.url).toContain('https://artifacts.example.org/storage/');
  });

  it('ignores a missing object when deleting product media', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    });
    await expect(
      deleteProductMediaObject({ send } as never, {
        bucket: pending.bucket,
        objectKey: pending.objectKey,
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls.at(0)?.at(0)).toBeInstanceOf(DeleteObjectCommand);
    expect(isMissingProductMediaObject({ name: 'NotFound' })).toBe(true);
  });
});
