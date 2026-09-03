export interface IdempotencyAttempt {
  fingerprint: string;
  key: string;
}

/**
 * Reuses the key for a retry of the same logical request and rotates it when
 * the request payload changes. Keep the returned attempt after ambiguous
 * network failures; clear it only after success or an explicit user cancel.
 */
export function resolveIdempotencyAttempt(
  current: IdempotencyAttempt | null,
  fingerprint: string,
  createKey: () => string = () => crypto.randomUUID(),
): IdempotencyAttempt {
  if (current?.fingerprint === fingerprint) return current;
  return { fingerprint, key: createKey() };
}
