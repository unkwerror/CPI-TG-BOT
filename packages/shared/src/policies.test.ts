import { describe, expect, it } from 'vitest';
import {
  canAccessArtifact,
  evaluateFilePolicy,
  eventAcceptsUploads,
  normalizePartList,
  parseCursorPagination,
  safeZipSegment,
  sanitizeDisplayName,
} from './policies';

describe('file policy', () => {
  it('rejects oversized files and configured extensions', () => {
    expect(
      evaluateFilePolicy({
        fileName: 'large.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 101,
        maxFileSizeBytes: 100,
      }),
    ).toMatchObject({ allowed: false, code: 'FILE_TOO_LARGE' });
    expect(
      evaluateFilePolicy({
        fileName: 'virus.exe',
        mimeType: 'application/octet-stream',
        sizeBytes: 10,
        maxFileSizeBytes: 100,
        blockedExtensions: ['exe'],
      }),
    ).toMatchObject({ allowed: false, code: 'FILE_TYPE_NOT_ALLOWED' });
  });

  it('accepts common files and quarantines executables by default', () => {
    expect(
      evaluateFilePolicy({
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        maxFileSizeBytes: 100,
      }),
    ).toEqual({ allowed: true, extension: 'pdf', requiresQuarantine: false });
    expect(
      evaluateFilePolicy({
        fileName: 'script.sh',
        mimeType: 'text/x-shellscript',
        sizeBytes: 10,
        maxFileSizeBytes: 100,
      }),
    ).toMatchObject({ allowed: true, requiresQuarantine: true });
  });
});

describe('event and authorization policies', () => {
  it('honors the upload period and event status', () => {
    const now = new Date('2026-07-29T10:00:00.000Z');
    expect(
      eventAcceptsUploads(
        {
          status: 'running',
          acceptUploadsFrom: new Date('2026-07-28T00:00:00.000Z'),
          acceptUploadsUntil: new Date('2026-07-30T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe(true);
    expect(
      eventAcceptsUploads(
        {
          status: 'finished',
          acceptUploadsFrom: new Date('2026-07-28T00:00:00.000Z'),
          acceptUploadsUntil: new Date('2026-07-30T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe(false);
  });

  it('prevents a participant from accessing another owner’s artifact', () => {
    expect(
      canAccessArtifact({
        currentUserId: 'u1',
        artifactOwnerId: 'u2',
        roles: ['participant'],
        status: 'ready',
      }),
    ).toBe(false);
    expect(
      canAccessArtifact({
        currentUserId: 'u1',
        artifactOwnerId: 'u2',
        roles: ['admin'],
        status: 'ready',
      }),
    ).toBe(true);
  });
});

describe('idempotent multipart and export paths', () => {
  it('deduplicates parts and sorts them', () => {
    expect(
      normalizePartList([
        { partNumber: 2, etag: '"old"' },
        { partNumber: 1, etag: '"one"' },
        { partNumber: 2, etag: '"two"' },
      ]),
    ).toEqual([
      { partNumber: 1, etag: 'one' },
      { partNumber: 2, etag: 'two' },
    ]);
  });

  it('sanitizes filenames and ZIP segments against traversal', () => {
    expect(sanitizeDisplayName('../../secret?.txt')).toBe('_.._secret_.txt');
    expect(safeZipSegment('../Иван / Петров')).not.toContain('/');
  });

  it('returns a stable cursor without loading an unbounded page', () => {
    expect(parseCursorPagination([{ id: '1' }, { id: '2' }, { id: '3' }], 2)).toEqual({
      items: [{ id: '1' }, { id: '2' }],
      nextCursor: '2',
    });
  });
});
