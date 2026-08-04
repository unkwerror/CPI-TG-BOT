import { describe, expect, it } from 'vitest';
import { validateCrmSyncResponse } from './crm-sync';

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
