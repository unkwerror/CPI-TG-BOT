import { describe, expect, it } from 'vitest';
import { isRetryableStatus, validateCrmSyncResponse } from './crm-sync';

describe('CRM sync response', () => {
  it('accepts the identifiers persisted by Locker', () => {
    expect(
      validateCrmSyncResponse({
        personId: '11111111-1111-4111-8111-111111111111',
        eventId: '22222222-2222-4222-8222-222222222222',
        artifactId: '33333333-3333-4333-8333-333333333333',
        artifactVersionId: '44444444-4444-4444-8444-444444444444',
        replayed: true,
      }),
    ).toMatchObject({ replayed: true });
  });

  it('rejects malformed identifiers', () => {
    expect(() => validateCrmSyncResponse({ personId: 'not-a-uuid' })).toThrow('invalid personId');
  });
});

describe('CRM sync retry policy', () => {
  it.each([500, 502, 503, 408, 429])('retries transient HTTP %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  // Повторы не исправят отклонённую полезную нагрузку и только скрывают
  // проблему: задача умирает после десяти попыток, ничего не оставив.
  it.each([400, 401, 403, 409, 422])('does not retry permanent HTTP %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});
