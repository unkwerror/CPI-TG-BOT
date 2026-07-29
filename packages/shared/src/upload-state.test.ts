import { describe, expect, it } from 'vitest';
import {
  completionIsIdempotent,
  missingPartNumbers,
  planUpload,
  uploadIsAbandoned,
} from './upload-state';

describe('upload planning and recovery', () => {
  it('uses a simple PUT below the multipart threshold', () => {
    expect(planUpload(1_000, 2_000, 500)).toEqual({
      type: 'simple',
      partSize: 1_000,
      partCount: 1,
    });
  });

  it('plans all multipart chunks including the short last part', () => {
    expect(planUpload(25, 10, 10)).toEqual({
      type: 'multipart',
      partSize: 10,
      partCount: 3,
    });
  });

  it('resumes only missing parts after a broken upload', () => {
    expect(missingPartNumbers(5, [1, 2, 4])).toEqual([3, 5]);
  });

  it('treats repeated completion as a no-op after object upload', () => {
    expect(completionIsIdempotent('uploaded')).toBe(true);
    expect(completionIsIdempotent('verifying')).toBe(true);
    expect(completionIsIdempotent('ready')).toBe(true);
    expect(completionIsIdempotent('uploading')).toBe(false);
  });

  it('selects only stale unfinished uploads for cleanup', () => {
    const cutoff = new Date('2026-07-29T12:00:00.000Z');
    expect(
      uploadIsAbandoned(
        { status: 'uploading', createdAt: new Date('2026-07-28T12:00:00.000Z') },
        cutoff,
      ),
    ).toBe(true);
    expect(
      uploadIsAbandoned(
        { status: 'ready', createdAt: new Date('2026-07-28T12:00:00.000Z') },
        cutoff,
      ),
    ).toBe(false);
  });
});
