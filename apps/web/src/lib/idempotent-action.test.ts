import { describe, expect, it, vi } from 'vitest';
import { resolveIdempotencyAttempt } from './idempotent-action';

describe('resolveIdempotencyAttempt', () => {
  it('reuses a key when a response-loss retry has the same payload', () => {
    const createKey = vi.fn(() => 'checkout-key');
    const first = resolveIdempotencyAttempt(null, '{"product":"one"}', createKey);
    const retry = resolveIdempotencyAttempt(first, '{"product":"one"}', createKey);

    expect(retry).toBe(first);
    expect(retry.key).toBe('checkout-key');
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('rotates the key when the logical request changes', () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce('first-key')
      .mockReturnValueOnce('second-key');
    const first = resolveIdempotencyAttempt(null, '{"size":"L"}', createKey);
    const changed = resolveIdempotencyAttempt(first, '{"size":"XL"}', createKey);

    expect(changed).toEqual({ fingerprint: '{"size":"XL"}', key: 'second-key' });
    expect(createKey).toHaveBeenCalledTimes(2);
  });
});
