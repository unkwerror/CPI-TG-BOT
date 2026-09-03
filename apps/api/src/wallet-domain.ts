import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@cpi/shared';

export const DEFAULT_QR_TTL_SECONDS = 120;
export const MAX_POINTS_PER_OPERATION = 1_000_000_000;

export interface LedgerDelta {
  accountId: string;
  delta: bigint;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Stable hash used to reject reuse of an Idempotency-Key with another request body. */
export function walletRequestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

export function requireIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Передайте уникальный заголовок Idempotency-Key длиной от 8 до 128 символов',
      400,
    );
  }
  return value;
}

export function pointsToBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_POINTS_PER_OPERATION) {
    throw new AppError(
      'POINT_AMOUNT_INVALID',
      `Количество баллов должно быть целым числом от 1 до ${MAX_POINTS_PER_OPERATION}`,
      400,
    );
  }
  return BigInt(value);
}

export function signedPointsToBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > MAX_POINTS_PER_OPERATION) {
    throw new AppError(
      'POINT_AMOUNT_INVALID',
      `Корректировка должна быть ненулевым целым числом от -${MAX_POINTS_PER_OPERATION} до ${MAX_POINTS_PER_OPERATION}`,
      400,
    );
  }
  return BigInt(value);
}

/**
 * Balance values are returned as decimal strings. This avoids silent precision loss if the
 * programme grows beyond Number.MAX_SAFE_INTEGER and keeps the API stable from day one.
 */
export function serializePoints(value: bigint | number | string): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

export function assertBalancedLedger(entries: LedgerDelta[]): void {
  if (entries.length < 2) {
    throw new Error('A ledger transaction needs at least two entries');
  }
  const accounts = new Set<string>();
  let total = 0n;
  for (const entry of entries) {
    if (entry.delta === 0n) throw new Error('A ledger entry cannot be zero');
    if (accounts.has(entry.accountId)) throw new Error('A ledger account cannot be repeated');
    accounts.add(entry.accountId);
    total += entry.delta;
  }
  if (total !== 0n) throw new Error('Ledger entries are not balanced');
}

export function createQrSecret(bytes = 32): { token: string; tokenHash: string } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, tokenHash: hashQrSecret(token) };
}

export function hashQrSecret(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function qrExpiry(now = new Date(), ttlSeconds = DEFAULT_QR_TTL_SECONDS): Date {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 600) {
    throw new Error('QR TTL must be between 15 and 600 seconds');
  }
  return new Date(now.getTime() + ttlSeconds * 1_000);
}

export function artifactRewardIdempotencyKey(eventId: string, userId: string): string {
  return `artifact-reward:${eventId}:${userId}`;
}

export function isWithinRewardWindow(
  eligibilityAt: Date,
  validFrom: Date | null,
  validUntil: Date | null,
): boolean {
  return (!validFrom || eligibilityAt >= validFrom) && (!validUntil || eligibilityAt <= validUntil);
}

export type StoreOrderStatus = 'paid' | 'pickup_requested' | 'ready_for_pickup' | 'fulfilled';

export function isStoreOrderTransitionAllowed(
  current: StoreOrderStatus,
  target: StoreOrderStatus,
): boolean {
  if (current === target) return true;
  return (
    (current === 'paid' && target === 'pickup_requested') ||
    (current === 'pickup_requested' && target === 'ready_for_pickup') ||
    (current === 'ready_for_pickup' && target === 'fulfilled')
  );
}
