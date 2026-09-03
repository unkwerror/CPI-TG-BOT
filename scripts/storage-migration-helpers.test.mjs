/* global Buffer */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertMigratedHead, createHashingBody } from './storage-migration-helpers.mjs';

describe('storage migration helpers', () => {
  it('hashes a source incrementally without assembling the whole file', async () => {
    async function* chunks() {
      yield Buffer.from('large-');
      yield Buffer.from('artifact');
    }
    const state = { sizeBytes: 0, checksumSha256: null };
    const seen = [];
    for await (const chunk of createHashingBody(chunks(), state)) seen.push(chunk.toString());

    expect(seen).toEqual(['large-', 'artifact']);
    expect(state.sizeBytes).toBe(14);
    expect(state.checksumSha256).toBe(createHash('sha256').update('large-artifact').digest('hex'));
  });

  it('requires exact size and migration metadata from target HEAD', () => {
    const expected = {
      sizeBytes: 14,
      artifactId: 'artifact-id',
      submissionId: 'submission-id',
      checksumSha256: 'checksum',
      mimeType: 'application/pdf',
    };
    expect(() =>
      assertMigratedHead(
        {
          ContentLength: 14,
          ContentType: 'application/pdf',
          Metadata: {
            artifact: 'artifact-id',
            submission: 'submission-id',
            sha256: 'checksum',
          },
        },
        expected,
      ),
    ).not.toThrow();
    expect(() =>
      assertMigratedHead(
        {
          ContentLength: 14,
          ContentType: 'application/pdf',
          Metadata: { artifact: 'artifact-id', submission: 'submission-id', sha256: 'wrong' },
        },
        expected,
      ),
    ).toThrow(/verification failed/);
  });
});
