import {
  DeleteObjectCommand,
  GetObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';
import type { feedPosts } from '@cpi/db';
import { AppError, publicStorageUrl } from '@cpi/shared';

export const FEED_COVER_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const FEED_COVER_UPLOAD_TTL_SECONDS = 300;
export const FEED_COVER_READ_TTL_SECONDS = 900;

export const feedCoverContentTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type FeedCoverContentType = (typeof feedCoverContentTypes)[number];

const extensionsByContentType: Record<FeedCoverContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface PendingFeedCoverObject {
  uploadId: string;
  postId: string;
  bucket: string;
  objectKey: string;
  contentType: FeedCoverContentType;
  sizeBytes: number;
}

export function feedCoverObjectKey(
  storagePrefix: string,
  postId: string,
  uploadId: string,
  contentType: FeedCoverContentType,
): string {
  return `${storagePrefix}feed/posts/${postId}/${uploadId}.${extensionsByContentType[contentType]}`;
}

export function feedCoverUploadMetadata(
  uploadId: string,
  postId: string,
  sizeBytes: number,
): Record<string, string> {
  return {
    'upload-id': uploadId,
    'feed-post-id': postId,
    'expected-size': String(sizeBytes),
  };
}

export function feedCoverPutHeaders(
  uploadId: string,
  postId: string,
  contentType: FeedCoverContentType,
  sizeBytes: number,
): Record<string, string> {
  const metadata = feedCoverUploadMetadata(uploadId, postId, sizeBytes);
  return {
    'content-type': contentType,
    'x-amz-meta-upload-id': metadata['upload-id']!,
    'x-amz-meta-feed-post-id': metadata['feed-post-id']!,
    'x-amz-meta-expected-size': metadata['expected-size']!,
  };
}

function normalizedContentType(value: string | undefined): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function normalizedMetadataValue(value: string | undefined): string {
  if (!value) return '';
  // Beget receives the signed metadata both from the presigned query and from the browser
  // headers through our reverse proxy, then exposes identical values joined by a comma.
  const values = value.split(',').map((item) => item.trim());
  return values.every((item) => item === values[0]) ? (values[0] ?? '') : value;
}

export function assertFeedCoverHead(
  pending: PendingFeedCoverObject,
  head: HeadObjectCommandOutput,
): void {
  const metadata = head.Metadata ?? {};
  if (
    head.ContentLength !== pending.sizeBytes ||
    pending.sizeBytes <= 0 ||
    pending.sizeBytes > FEED_COVER_MAX_SIZE_BYTES ||
    normalizedContentType(head.ContentType) !== pending.contentType ||
    normalizedMetadataValue(metadata['upload-id']) !== pending.uploadId ||
    normalizedMetadataValue(metadata['feed-post-id']) !== pending.postId ||
    normalizedMetadataValue(metadata['expected-size']) !== String(pending.sizeBytes)
  ) {
    throw new AppError(
      'FEED_COVER_OBJECT_MISMATCH',
      'Загруженная обложка не соответствует выданному разрешению',
      409,
    );
  }
}

async function responseBytes(body: unknown): Promise<Uint8Array> {
  if (!body || typeof body !== 'object') {
    throw new AppError('FEED_COVER_OBJECT_EMPTY', 'Загруженная обложка пуста', 409);
  }
  const runtimeBody = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };
  if (runtimeBody.transformToByteArray) return runtimeBody.transformToByteArray();
  if (runtimeBody[Symbol.asyncIterator]) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of runtimeBody as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  throw new AppError('FEED_COVER_OBJECT_UNREADABLE', 'Не удалось проверить обложку', 409);
}

export async function assertFeedCoverSignature(
  s3: S3Client,
  pending: PendingFeedCoverObject,
): Promise<void> {
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: pending.bucket,
      Key: pending.objectKey,
      Range: 'bytes=0-4095',
    }),
  );
  const detected = await fileTypeFromBuffer(await responseBytes(object.Body));
  if (!detected || detected.mime !== pending.contentType) {
    throw new AppError(
      'FEED_COVER_SIGNATURE_MISMATCH',
      'Обложка должна быть настоящим JPEG, PNG или WebP',
      409,
    );
  }
}

export function isMissingFeedCoverObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export async function deleteFeedCoverObject(
  s3: S3Client,
  cover: { coverBucket: string | null; coverObjectKey: string | null },
): Promise<void> {
  if (!cover.coverBucket || !cover.coverObjectKey) return;
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: cover.coverBucket,
        Key: cover.coverObjectKey,
      }),
    );
  } catch (error) {
    if (!isMissingFeedCoverObject(error)) throw error;
  }
}

type FeedPostCover = Pick<
  typeof feedPosts.$inferSelect,
  'coverUrl' | 'coverBucket' | 'coverObjectKey' | 'coverContentType'
>;

export async function serializeFeedCoverUrl(
  s3: S3Client,
  config: { S3_PUBLIC_BASE: string; PRESIGNED_URL_TTL_SECONDS: number },
  post: FeedPostCover,
): Promise<string | null> {
  if (!post.coverBucket || !post.coverObjectKey) return post.coverUrl;
  const signed = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: post.coverBucket,
      Key: post.coverObjectKey,
      ResponseContentType: post.coverContentType ?? undefined,
      ResponseContentDisposition: 'inline',
    }),
    {
      expiresIn: Math.min(config.PRESIGNED_URL_TTL_SECONDS, FEED_COVER_READ_TTL_SECONDS),
    },
  );
  return publicStorageUrl(signed, config.S3_PUBLIC_BASE);
}
