import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertClamavReady, hashAndOptionallyScan } from './clamav';

async function* bytes(): AsyncIterable<Uint8Array> {
  yield Buffer.from('artifact');
}

describe('ClamAV streaming scan', () => {
  it('fails readiness when the configured scanner cannot be reached', async () => {
    await expect(
      assertClamavReady({ host: '127.0.0.1', port: 1, timeoutMs: 250 }),
    ).rejects.toThrow();
  });

  it('fails closed when the configured scanner cannot be reached', async () => {
    await expect(
      hashAndOptionallyScan(bytes(), createHash('sha256'), {
        host: '127.0.0.1',
        // TCP/1 is reserved and intentionally has no listener in the test environment.
        port: 1,
        timeoutMs: 250,
      }),
    ).rejects.toThrow();
  });
});
