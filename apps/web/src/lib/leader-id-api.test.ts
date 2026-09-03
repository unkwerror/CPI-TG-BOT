import { describe, expect, it } from 'vitest';
import { ApiClientError } from './api';
import {
  canRetryLeaderIdSubscription,
  classifyLeaderIdError,
  leaderIdResultNeedsExternalAction,
  leaderIdSubscriptionHeading,
  leaderIdSubscriptionSummary,
  normalizeLeaderIdStatus,
  safeAuthorizationUrl,
  validateLeaderIdInput,
} from './leader-id-api';

describe('Leader-ID frontend contract', () => {
  it('validates the input format without treating digits as verified identity', () => {
    expect(validateLeaderIdInput('')).toBe('empty');
    expect(validateLeaderIdInput('606 466')).toBe('invalid');
    expect(validateLeaderIdInput('https://leader-id.ru/users/1')).toBe('invalid');
    expect(validateLeaderIdInput('0')).toBe('invalid');
    expect(validateLeaderIdInput('012345')).toBe('invalid');
    expect(validateLeaderIdInput('12345678901234567')).toBe('invalid');
    expect(validateLeaderIdInput('123456')).toBeNull();
  });

  it('uses safe, user-facing error categories', () => {
    expect(
      classifyLeaderIdError(new ApiClientError('raw upstream text', 'LEADER_ID_NOT_FOUND', 404)),
    ).toMatchObject({ kind: 'not_found', retryable: false });
    expect(
      classifyLeaderIdError(new ApiClientError('failed to fetch', 'NETWORK_ERROR', 0)),
    ).toMatchObject({ kind: 'network', retryable: true });
    expect(classifyLeaderIdError(new Error('private stack detail')).message).not.toContain(
      'private stack detail',
    );
  });

  it('allows only regular web authorization URLs returned by the backend', () => {
    expect(safeAuthorizationUrl('https://leader-id.ru/oauth/authorize?state=abc')).toContain(
      'https://leader-id.ru/',
    );
    expect(safeAuthorizationUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthorizationUrl('https://leader-id.ru.attacker.example/oauth')).toBeNull();
    expect(safeAuthorizationUrl('http://leader-id.ru/oauth')).toBeNull();
    expect(safeAuthorizationUrl('/relative')).toBeNull();
  });

  it('summarizes full and partial registration without exposing raw event errors', () => {
    expect(
      leaderIdSubscriptionSummary({
        status: 'completed',
        total: 4,
        satisfied: 4,
        pending: 0,
        failed: 0,
      }),
    ).toMatch(/всем мероприятиям/u);
    expect(
      leaderIdSubscriptionSummary({
        status: 'partial',
        total: 4,
        satisfied: 3,
        pending: 0,
        failed: 1,
      }),
    ).toContain('3 из 4');
  });

  it('distinguishes a terminal failure from partial success and directs the external step', () => {
    const failed = {
      status: 'failed' as const,
      total: 1,
      satisfied: 0,
      pending: 0,
      failed: 1,
      results: [
        {
          eventId: 'event-606466',
          leaderIdEventId: 606466,
          title: 'Catalyst',
          status: 'FAILED' as const,
          retryable: false,
        },
      ],
    };

    expect(leaderIdSubscriptionHeading(failed)).toBe('Catalyst пока не подключён');
    expect(leaderIdSubscriptionSummary(failed)).toContain('странице мероприятия');
    expect(canRetryLeaderIdSubscription(failed)).toBe(false);
    expect(leaderIdResultNeedsExternalAction(failed.results[0]!)).toBe(true);
  });

  it('normalizes the backend snapshot and preserves completion across reloads', () => {
    expect(
      normalizeLeaderIdStatus({
        linked: true,
        leaderIdUserId: 123456,
        totalEvents: 2,
        confirmedEvents: 1,
        submittedEvents: 2,
        failedEvents: 0,
        subscriptionComplete: true,
        partial: false,
        results: [
          {
            catalystEventId: 'event-a',
            leaderIdEventId: 100,
            title: 'Событие A',
            requiredForSubscription: true,
            status: 'REGISTERED',
            retryable: false,
          },
          {
            catalystEventId: 'event-b',
            leaderIdEventId: 200,
            title: 'Событие B',
            requiredForSubscription: true,
            status: 'PENDING_APPROVAL',
            retryable: false,
          },
        ],
        reward: { configured: true, points: '250', awarded: true },
      }),
    ).toMatchObject({
      binding: { status: 'linked', leaderId: '123456' },
      subscription: { status: 'completed', total: 2, satisfied: 2, pending: 1 },
      reward: { amount: '250', awarded: true },
    });
  });

  it('keeps the immutable awarded amount visible after the current offer is disabled', () => {
    expect(
      normalizeLeaderIdStatus({
        linked: true,
        leaderIdUserId: 123456,
        totalEvents: 0,
        confirmedEvents: 0,
        submittedEvents: 0,
        failedEvents: 0,
        subscriptionComplete: false,
        partial: false,
        results: [],
        reward: { configured: false, points: '100', awarded: true },
      }),
    ).toMatchObject({ reward: { amount: '100', awarded: true } });
  });
});
