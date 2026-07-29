import type { ArtifactStatus } from './types';

export interface MultipartPlan {
  type: 'simple' | 'multipart';
  partSize: number;
  partCount: number;
}

export function planUpload(
  sizeBytes: number,
  multipartThresholdBytes: number,
  multipartPartSizeBytes: number,
): MultipartPlan {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('File size must be a positive safe integer');
  }
  if (sizeBytes < multipartThresholdBytes) {
    return { type: 'simple', partSize: sizeBytes, partCount: 1 };
  }
  const partCount = Math.ceil(sizeBytes / multipartPartSizeBytes);
  if (partCount > 10_000) throw new Error('S3 multipart upload cannot exceed 10,000 parts');
  return { type: 'multipart', partSize: multipartPartSizeBytes, partCount };
}

export function missingPartNumbers(partCount: number, uploadedParts: number[]): number[] {
  const uploaded = new Set(uploadedParts);
  return Array.from({ length: partCount }, (_value, index) => index + 1).filter(
    (partNumber) => !uploaded.has(partNumber),
  );
}

export function completionIsIdempotent(status: ArtifactStatus): boolean {
  return ['uploaded', 'verifying', 'ready'].includes(status);
}

export function uploadIsAbandoned(
  artifact: { status: ArtifactStatus; createdAt: Date },
  before: Date,
): boolean {
  return ['created', 'uploading'].includes(artifact.status) && artifact.createdAt < before;
}
