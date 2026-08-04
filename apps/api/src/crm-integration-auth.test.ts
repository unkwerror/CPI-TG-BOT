import { describe, expect, it } from 'vitest';
import { isCrmIntegrationAuthorizationValid } from './crm-integration-auth';

describe('CRM integration authorization', () => {
  const token = 'crm-integration-token-that-is-long-enough';

  it('uses an exact bearer token', () => {
    expect(isCrmIntegrationAuthorizationValid(`Bearer ${token}`, token)).toBe(true);
    expect(isCrmIntegrationAuthorizationValid(`Bearer ${token}x`, token)).toBe(false);
    expect(isCrmIntegrationAuthorizationValid(token, token)).toBe(false);
    expect(isCrmIntegrationAuthorizationValid(undefined, token)).toBe(false);
  });
});
