import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  artifactRewardIdempotencyKey,
  assertBalancedLedger,
  createQrSecret,
  hashQrSecret,
  isWithinRewardWindow,
  isStoreOrderTransitionAllowed,
  pointsToBigInt,
  qrExpiry,
  requireIdempotencyKey,
  serializePoints,
  signedPointsToBigInt,
  walletRequestHash,
} from './wallet-domain';

describe('wallet domain invariants', () => {
  it('hashes semantically identical request objects equally', () => {
    expect(walletRequestHash({ amount: 10, memo: 'x' })).toBe(
      walletRequestHash({ memo: 'x', amount: 10 }),
    );
    expect(walletRequestHash({ amount: 11, memo: 'x' })).not.toBe(
      walletRequestHash({ amount: 10, memo: 'x' }),
    );
  });

  it('requires a bounded idempotency key', () => {
    expect(requireIdempotencyKey('request-123')).toBe('request-123');
    expect(() => requireIdempotencyKey('short')).toThrow(/Idempotency-Key/);
    expect(() => requireIdempotencyKey(undefined)).toThrow(/Idempotency-Key/);
  });

  it('accepts only positive safe point amounts and bounded signed adjustments', () => {
    expect(pointsToBigInt(100)).toBe(100n);
    expect(signedPointsToBigInt(-100)).toBe(-100n);
    expect(() => pointsToBigInt(0)).toThrow(/целым числом/);
    expect(() => pointsToBigInt(1.5)).toThrow(/целым числом/);
    expect(() => signedPointsToBigInt(0)).toThrow(/ненулевым/);
  });

  it('enforces double-entry balancing and one entry per account', () => {
    expect(() =>
      assertBalancedLedger([
        { accountId: 'source', delta: -50n },
        { accountId: 'target', delta: 50n },
      ]),
    ).not.toThrow();
    expect(() =>
      assertBalancedLedger([
        { accountId: 'source', delta: -49n },
        { accountId: 'target', delta: 50n },
      ]),
    ).toThrow(/not balanced/);
    expect(() =>
      assertBalancedLedger([
        { accountId: 'same', delta: -50n },
        { accountId: 'same', delta: 50n },
      ]),
    ).toThrow(/repeated/);
  });

  it('preserves double-entry balance for arbitrary batches of transfers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 30 }),
        (amounts) => {
          const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
          const entries = amounts.map((amount, index) => ({
            accountId: `source-${index}`,
            delta: -BigInt(amount),
          }));
          expect(() =>
            assertBalancedLedger([...entries, { accountId: 'sink', delta: total }]),
          ).not.toThrow();
          expect(() =>
            assertBalancedLedger([...entries, { accountId: 'sink', delta: total + 1n }]),
          ).toThrow(/not balanced/);
        },
      ),
    );
  });

  it('never stores a QR bearer secret in plaintext and expires it quickly', () => {
    const { token, tokenHash } = createQrSecret();
    expect(token).not.toBe(tokenHash);
    expect(tokenHash).toBe(hashQrSecret(token));
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(qrExpiry(new Date('2026-08-15T00:00:00Z')).toISOString()).toBe(
      '2026-08-15T00:02:00.000Z',
    );
  });

  it('serializes bigint balances without precision loss', () => {
    expect(serializePoints(9_007_199_254_740_993n)).toBe('9007199254740993');
  });

  it('keys artifact rewards once per event and user, independent of a submission', () => {
    expect(artifactRewardIdempotencyKey('event-a', 'user-a')).toBe(
      artifactRewardIdempotencyKey('event-a', 'user-a'),
    );
    expect(artifactRewardIdempotencyKey('event-a', 'user-a')).not.toBe(
      artifactRewardIdempotencyKey('event-b', 'user-a'),
    );
  });

  it('reconciles by the artifact eligibility time, not by the later job time', () => {
    const validFrom = new Date('2026-08-01T00:00:00Z');
    const validUntil = new Date('2026-08-10T00:00:00Z');
    expect(isWithinRewardWindow(new Date('2026-08-05T12:00:00Z'), validFrom, validUntil)).toBe(
      true,
    );
    expect(isWithinRewardWindow(new Date('2026-08-11T00:00:00Z'), validFrom, validUntil)).toBe(
      false,
    );
  });

  it('allows only the no-refund store order progression', () => {
    expect(isStoreOrderTransitionAllowed('paid', 'pickup_requested')).toBe(true);
    expect(isStoreOrderTransitionAllowed('pickup_requested', 'ready_for_pickup')).toBe(true);
    expect(isStoreOrderTransitionAllowed('ready_for_pickup', 'fulfilled')).toBe(true);
    expect(isStoreOrderTransitionAllowed('fulfilled', 'paid')).toBe(false);
    expect(isStoreOrderTransitionAllowed('paid', 'fulfilled')).toBe(false);
  });
});
