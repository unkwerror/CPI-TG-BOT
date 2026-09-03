import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { assertStorageCutoverInvariant } from './storage-readiness';

describe('storage cutover readiness', () => {
  it('accepts a database with no references outside the new bucket and prefix', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] }),
    } as unknown as Database;
    await expect(assertStorageCutoverInvariant(db, 'shared', 'locker/')).resolves.toBeUndefined();
  });

  it('fails closed while an old artifact or export reference remains', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }),
    } as unknown as Database;
    await expect(assertStorageCutoverInvariant(db, 'shared', 'locker/')).rejects.toThrow(
      'artifacts=2, exports=1',
    );
  });
});
