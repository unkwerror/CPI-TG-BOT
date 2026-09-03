import {
  DeleteObjectCommand,
  GetObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';
import { AppError, publicStorageUrl } from '@cpi/shared';
import type { storeProductMedia } from '@cpi/db';

export const PRODUCT_MEDIA_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const PRODUCT_MEDIA_UPLOAD_TTL_SECONDS = 300;
export const PRODUCT_MEDIA_READ_TTL_SECONDS = 900;

export const productImageContentTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ProductImageContentType = (typeof productImageContentTypes)[number];

const extensionsByContentType: Record<ProductImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface PendingProductMediaObject {
  id: string;
  productId: string;
  bucket: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  uploadExpiresAt: Date;
}

export function productMediaObjectKey(
  storagePrefix: string,
  productId: string,
  mediaId: string,
  contentType: ProductImageContentType,
): string {
  const extension = extensionsByContentType[contentType];
  return `${storagePrefix}store/products/${productId}/${mediaId}.${extension}`;
}

export function productMediaUploadMetadata(
  mediaId: string,
  productId: string,
  sizeBytes: number,
): Record<string, string> {
  return {
    'upload-id': mediaId,
    'product-id': productId,
    'expected-size': String(sizeBytes),
  };
}

export function productMediaPutHeaders(
  mediaId: string,
  productId: string,
  contentType: string,
  sizeBytes: number,
): Record<string, string> {
  const metadata = productMediaUploadMetadata(mediaId, productId, sizeBytes);
  return {
    'content-type': contentType,
    'x-amz-meta-upload-id': metadata['upload-id']!,
    'x-amz-meta-product-id': metadata['product-id']!,
    'x-amz-meta-expected-size': metadata['expected-size']!,
  };
}

function normalizedContentType(value: string | undefined): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function assertProductMediaHead(
  pending: PendingProductMediaObject,
  head: HeadObjectCommandOutput,
): void {
  const metadata = head.Metadata ?? {};
  if (
    head.ContentLength !== pending.sizeBytes ||
    pending.sizeBytes <= 0 ||
    pending.sizeBytes > PRODUCT_MEDIA_MAX_SIZE_BYTES ||
    normalizedContentType(head.ContentType) !== pending.contentType ||
    metadata['upload-id'] !== pending.id ||
    metadata['product-id'] !== pending.productId ||
    metadata['expected-size'] !== String(pending.sizeBytes)
  ) {
    throw new AppError(
      'PRODUCT_MEDIA_OBJECT_MISMATCH',
      'Загруженный файл не соответствует выданному разрешению',
      409,
    );
  }
}

async function responseBytes(body: unknown): Promise<Uint8Array> {
  if (!body || typeof body !== 'object') {
    throw new AppError('PRODUCT_MEDIA_OBJECT_EMPTY', 'Загруженный файл пуст', 409);
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
  throw new AppError('PRODUCT_MEDIA_OBJECT_UNREADABLE', 'Не удалось проверить изображение', 409);
}

export async function assertProductMediaSignature(
  s3: S3Client,
  pending: PendingProductMediaObject,
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
      'PRODUCT_MEDIA_SIGNATURE_MISMATCH',
      'Содержимое файла не соответствует JPEG, PNG или WebP',
      409,
    );
  }
}

export type ProductMediaRow = typeof storeProductMedia.$inferSelect;

export interface ProductMediaDto {
  id: string;
  productId: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: Date;
}

export async function serializeReadyProductMedia(
  s3: S3Client,
  config: {
    S3_PUBLIC_BASE: string;
    PRESIGNED_URL_TTL_SECONDS: number;
  },
  media: ProductMediaRow,
): Promise<ProductMediaDto | null> {
  if (media.uploadStatus !== 'ready') return null;
  let url = media.url;
  if (media.bucket && media.objectKey) {
    const expiresIn = Math.min(config.PRESIGNED_URL_TTL_SECONDS, PRODUCT_MEDIA_READ_TTL_SECONDS);
    const signed = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: media.bucket,
        Key: media.objectKey,
        ResponseContentType: media.contentType ?? undefined,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn },
    );
    url = publicStorageUrl(signed, config.S3_PUBLIC_BASE);
  }
  if (!url) return null;
  return {
    id: media.id,
    productId: media.productId,
    url,
    altText: media.altText,
    sortOrder: media.sortOrder,
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    createdAt: media.createdAt,
  };
}

export function isMissingProductMediaObject(error: unknown): boolean {
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

export async function deleteProductMediaObject(
  s3: S3Client,
  media: { bucket: string | null; objectKey: string | null },
): Promise<void> {
  if (!media.bucket || !media.objectKey) return;
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: media.bucket,
        Key: media.objectKey,
      }),
    );
  } catch (error) {
    if (!isMissingProductMediaObject(error)) throw error;
  }
}

export async function serializeReadyProductMediaList(
  s3: S3Client,
  config: {
    S3_PUBLIC_BASE: string;
    PRESIGNED_URL_TTL_SECONDS: number;
  },
  media: ProductMediaRow[],
): Promise<ProductMediaDto[]> {
  const serialized = await Promise.all(
    media.map((item) => serializeReadyProductMedia(s3, config, item)),
  );
  return serialized.filter((item): item is ProductMediaDto => item !== null);
}
