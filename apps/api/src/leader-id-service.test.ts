import { describe, expect, it, vi } from 'vitest';
import type {
  CatalystLeaderIdEvent,
  LeaderIdApiClient,
  LeaderIdBinding,
  LeaderIdBindingRepository,
  CreateLeaderIdParticipationInput,
  LeaderIdOAuthStateManager,
  LeaderIdRegistrationRepository,
  LeaderIdRewardGrant,
  LeaderIdRewardIssuer,
  LeaderIdRewardPolicy,
  LeaderIdTokenCipher,
  LeaderIdTokenSet,
  StoredLeaderIdRegistrationResult,
} from './leader-id-contract';
import { leaderIdPostOutcomeUnknown } from './leader-id-contract';
import { LeaderIdApiError } from './leader-id-client';
import { LeaderIdService } from './leader-id-service';

const NOW = '2026-08-28T05:00:00.000Z';
const CATALYST_USER_ID = 'catalyst-user';
const LEADER_ID_USER_ID = 77;

const defaultPolicy: LeaderIdRewardPolicy = {
  active: true,
  reason: 'LEADER_ID_CATALYST_SUBSCRIPTION',
  points: 250n,
  requireAllRequiredEvents: true,
  qualifyingStatuses: ['REGISTERED', 'ALREADY_REGISTERED', 'PENDING_APPROVAL'],
};

function event(
  id: string,
  leaderIdEventId: number,
  overrides: Partial<CatalystLeaderIdEvent> = {},
): CatalystLeaderIdEvent {
  return {
    id,
    leaderIdEventId,
    title: `Event ${leaderIdEventId}`,
    active: true,
    requiredForSubscription: true,
    registrationOpen: true,
    sortOrder: leaderIdEventId,
    requiresQuestionnaire: false,
    ...overrides,
  };
}

function fakeClient(overrides: Partial<LeaderIdApiClient> = {}): LeaderIdApiClient {
  return {
    createAuthorizationUrl: vi.fn(() => 'https://leader-id.ru/apps/authorize?state=opaque'),
    exchangeAuthorizationCode: vi.fn(async () => ({
      accessToken: 'user-access-token',
      refreshToken: 'user-refresh-token',
      leaderIdUserId: LEADER_ID_USER_ID,
    })),
    exchangeClientCredentials: vi.fn(async () => ({ accessToken: 'application-token' })),
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'refreshed-token' })),
    getUser: vi.fn(async (userId: number) => ({ id: userId })),
    listParticipations: vi.fn(async () => []),
    createParticipation: vi.fn(async (input: CreateLeaderIdParticipationInput) => ({
      id: `participation-${input.eventId}`,
      eventId: input.eventId,
      moderation: 'approved' as const,
      completed: false,
    })),
    ...overrides,
  };
}

class MemoryBindingRepository implements LeaderIdBindingRepository {
  readonly byCatalystUser = new Map<string, LeaderIdBinding>();
  readonly upserts: LeaderIdBinding[] = [];

  constructor(binding?: LeaderIdBinding) {
    if (binding) this.byCatalystUser.set(binding.catalystUserId, binding);
  }

  async findByCatalystUserId(catalystUserId: string): Promise<LeaderIdBinding | null> {
    return this.byCatalystUser.get(catalystUserId) ?? null;
  }

  async findByLeaderIdUserId(leaderIdUserId: number): Promise<LeaderIdBinding | null> {
    return (
      [...this.byCatalystUser.values()].find(
        (binding) => binding.leaderIdUserId === leaderIdUserId,
      ) ?? null
    );
  }

  async upsertVerifiedBinding(binding: LeaderIdBinding): Promise<boolean> {
    this.upserts.push(binding);
    const current = this.byCatalystUser.get(binding.catalystUserId);
    if (!current || Date.parse(current.linkedAt) < Date.parse(binding.linkedAt)) {
      this.byCatalystUser.set(binding.catalystUserId, binding);
      return true;
    }
    return false;
  }

  async updateEncryptedTokens(input: {
    catalystUserId: string;
    expectedLeaderIdUserId: number;
    expectedLinkedAt: string;
    encryptedTokens: string;
    tokenExpiresAt?: string;
  }): Promise<void> {
    const current = this.byCatalystUser.get(input.catalystUserId);
    if (
      !current ||
      current.leaderIdUserId !== input.expectedLeaderIdUserId ||
      current.linkedAt !== input.expectedLinkedAt
    ) {
      throw new Error('binding not found or changed');
    }
    this.byCatalystUser.set(input.catalystUserId, {
      ...current,
      encryptedTokens: input.encryptedTokens,
      ...(input.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: input.tokenExpiresAt }),
    });
  }
}

class MemoryRegistrationRepository implements LeaderIdRegistrationRepository {
  readonly results = new Map<string, StoredLeaderIdRegistrationResult>();
  readonly saves: StoredLeaderIdRegistrationResult[] = [];

  #key(catalystUserId: string, catalystEventId: string): string {
    return `${catalystUserId}:${catalystEventId}`;
  }

  async withUserLock<T>(_catalystUserId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async findResult(
    catalystUserId: string,
    catalystEventId: string,
  ): Promise<StoredLeaderIdRegistrationResult | null> {
    return this.results.get(this.#key(catalystUserId, catalystEventId)) ?? null;
  }

  async saveResult(
    result: StoredLeaderIdRegistrationResult,
    expectedPrevious: StoredLeaderIdRegistrationResult | null,
  ): Promise<StoredLeaderIdRegistrationResult> {
    const key = this.#key(result.catalystUserId, result.catalystEventId);
    const current = this.results.get(key);
    const sameSnapshotAsPrevious =
      expectedPrevious !== null &&
      result.leaderIdUserId === expectedPrevious.leaderIdUserId &&
      result.leaderIdEventId === expectedPrevious.leaderIdEventId;
    const expectedMatches = expectedPrevious
      ? current?.leaderIdUserId === expectedPrevious.leaderIdUserId &&
        current.leaderIdEventId === expectedPrevious.leaderIdEventId &&
        current.attemptCount === expectedPrevious.attemptCount &&
        current.claimToken === expectedPrevious.claimToken &&
        !(expectedPrevious.claimToken && sameSnapshotAsPrevious)
      : current === undefined;
    if (!expectedMatches) {
      if (!current) throw new Error('registration CAS row disappeared');
      return current;
    }
    this.saves.push(result);
    this.results.set(key, result);
    return result;
  }

  async claimAttempt(
    result: StoredLeaderIdRegistrationResult,
    expectedAttemptCount: number,
  ): Promise<boolean> {
    if (!result.claimToken) throw new Error('attempt claim token missing');
    const key = this.#key(result.catalystUserId, result.catalystEventId);
    const current = this.results.get(key);
    const snapshotsChanged =
      current !== undefined &&
      (current.leaderIdUserId !== result.leaderIdUserId ||
        current.leaderIdEventId !== result.leaderIdEventId);
    if (
      current &&
      !snapshotsChanged &&
      (current.attemptCount !== expectedAttemptCount ||
        current.errorCode === leaderIdPostOutcomeUnknown)
    ) {
      return false;
    }
    this.results.set(key, result);
    return true;
  }

  async completeClaim(
    result: StoredLeaderIdRegistrationResult,
  ): Promise<StoredLeaderIdRegistrationResult> {
    const key = this.#key(result.catalystUserId, result.catalystEventId);
    const current = this.results.get(key);
    if (
      current &&
      current.leaderIdUserId === result.leaderIdUserId &&
      current.leaderIdEventId === result.leaderIdEventId &&
      current.attemptCount === result.attemptCount &&
      current.claimToken === result.claimToken &&
      current.errorCode === leaderIdPostOutcomeUnknown
    ) {
      const completed = { ...result };
      delete completed.claimToken;
      this.results.set(key, completed);
      this.saves.push(completed);
      return completed;
    }
    if (!current) throw new Error('attempt claim missing');
    return current;
  }

  async listResults(catalystUserId: string): Promise<StoredLeaderIdRegistrationResult[]> {
    return [...this.results.values()].filter((result) => result.catalystUserId === catalystUserId);
  }
}

type AwardInput = Parameters<LeaderIdRewardIssuer['awardOnce']>[0];

class MemoryRewardIssuer implements LeaderIdRewardIssuer {
  readonly grants = new Map<string, LeaderIdRewardGrant>();
  readonly awardCalls: AwardInput[] = [];

  #key(catalystUserId: string, reason: string): string {
    return `${catalystUserId}:${reason}`;
  }

  async awardOnce(input: AwardInput): Promise<LeaderIdRewardGrant> {
    this.awardCalls.push(input);
    const key = this.#key(input.catalystUserId, input.reason);
    const existing = this.grants.get(key);
    if (existing) {
      return { ...existing, awarded: false, replayed: true };
    }
    const grant: LeaderIdRewardGrant = {
      awarded: true,
      replayed: false,
      points: input.points,
      transactionId: 'reward-transaction',
    };
    this.grants.set(key, grant);
    return grant;
  }

  async findGrant(catalystUserId: string, reason: string): Promise<LeaderIdRewardGrant | null> {
    return this.grants.get(this.#key(catalystUserId, reason)) ?? null;
  }
}

const tokenCipher: LeaderIdTokenCipher = {
  encrypt: (tokens) => JSON.stringify(tokens),
  decrypt: (envelope) => JSON.parse(envelope) as LeaderIdTokenSet,
};

function linkedBinding(
  tokens: LeaderIdTokenSet = {
    accessToken: 'user-access-token',
    refreshToken: 'user-refresh-token',
    leaderIdUserId: LEADER_ID_USER_ID,
  },
): LeaderIdBinding {
  return {
    catalystUserId: CATALYST_USER_ID,
    leaderIdUserId: LEADER_ID_USER_ID,
    encryptedTokens: tokenCipher.encrypt(tokens, CATALYST_USER_ID),
    linkedAt: NOW,
  };
}

function serviceFixture(
  input: {
    client?: LeaderIdApiClient;
    bindings?: MemoryBindingRepository;
    registrations?: MemoryRegistrationRepository;
    rewards?: MemoryRewardIssuer;
    events?: CatalystLeaderIdEvent[];
    policy?: LeaderIdRewardPolicy | null;
    oauthState?: LeaderIdOAuthStateManager;
  } = {},
) {
  const bindings = input.bindings ?? new MemoryBindingRepository(linkedBinding());
  const registrations = input.registrations ?? new MemoryRegistrationRepository();
  const rewards = input.rewards ?? new MemoryRewardIssuer();
  const client = input.client ?? fakeClient();
  const activeEvents = input.events ?? [event('event-606466', 606466)];
  const oauthState = input.oauthState ?? {
    issue: vi.fn(async () => Buffer.alloc(32, 2).toString('base64url')),
    consume: vi.fn(async () => ({
      catalystUserId: CATALYST_USER_ID,
      expectedLeaderIdUserId: LEADER_ID_USER_ID,
      createdAt: NOW,
      expiresAt: '2026-08-28T05:10:00.000Z',
    })),
  };
  const policy = input.policy === undefined ? defaultPolicy : input.policy;
  const service = new LeaderIdService({
    client,
    oauthState,
    tokenCipher,
    bindings,
    events: { listActiveEvents: vi.fn(async () => activeEvents) },
    registrations,
    rewardPolicies: { getPolicy: vi.fn(async () => policy) },
    rewards,
    serverCredentials: {
      clientId: 'leader-id-server-client',
      clientSecret: 'leader-id-server-secret',
    },
    oauth: {
      clientId: 'leader-id-client',
      clientSecret: 'leader-id-secret',
      redirectUri: 'https://catalyst.example/api/v1/catalyst/leader-id/oauth/callback',
    },
    now: () => new Date(NOW),
    sleep: vi.fn(async () => undefined),
    maximumReadAttempts: 1,
  });
  return { service, client, bindings, registrations, rewards, oauthState };
}

describe('Leader-ID OAuth binding', () => {
  it('checks existence but does not bind a typed ID before one OAuth consent', async () => {
    const bindings = new MemoryBindingRepository();
    const exchangeClientCredentials = vi.fn(async () => ({ accessToken: 'application-token' }));
    const getUser = vi.fn(async (userId: number) => ({ id: userId }));
    const client = fakeClient({ exchangeClientCredentials, getUser });
    const issue = vi.fn(async () => Buffer.alloc(32, 3).toString('base64url'));
    const oauthState: LeaderIdOAuthStateManager = {
      issue,
      consume: vi.fn(),
    };
    const { service } = serviceFixture({ bindings, client, oauthState });

    await expect(
      service.beginLink({
        catalystUserId: CATALYST_USER_ID,
        expectedLeaderIdUserId: LEADER_ID_USER_ID,
      }),
    ).resolves.toEqual({
      authorizationUrl: 'https://leader-id.ru/apps/authorize?state=opaque',
    });
    expect(exchangeClientCredentials).toHaveBeenCalledOnce();
    expect(exchangeClientCredentials).toHaveBeenCalledWith({
      clientId: 'leader-id-server-client',
      clientSecret: 'leader-id-server-secret',
    });
    expect(getUser).toHaveBeenCalledWith(LEADER_ID_USER_ID, 'application-token');
    expect(issue).toHaveBeenCalledOnce();
    expect(bindings.upserts).toHaveLength(0);
  });

  it('rejects an OAuth callback for a different Leader-ID before persisting tokens', async () => {
    const bindings = new MemoryBindingRepository();
    const getUser = vi.fn(async (userId: number) => ({ id: userId }));
    const client = fakeClient({
      exchangeAuthorizationCode: vi.fn(async () => ({
        accessToken: 'other-user-token',
        leaderIdUserId: LEADER_ID_USER_ID + 1,
      })),
      getUser,
    });
    const { service } = serviceFixture({ bindings, client });

    await expect(
      service.completeLink({ state: Buffer.alloc(32, 2).toString('base64url'), code: 'code' }),
    ).rejects.toMatchObject({ code: 'LEADER_ID_OWNERSHIP_MISMATCH', statusCode: 409 });
    expect(bindings.upserts).toHaveLength(0);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('does not let an older OAuth tab overwrite a newer verified binding', async () => {
    const newerBinding: LeaderIdBinding = {
      ...linkedBinding(),
      leaderIdUserId: LEADER_ID_USER_ID + 1,
      linkedAt: '2026-08-28T05:01:00.000Z',
    };
    const bindings = new MemoryBindingRepository(newerBinding);
    const oauthState: LeaderIdOAuthStateManager = {
      issue: vi.fn(),
      consume: vi.fn(async () => ({
        catalystUserId: CATALYST_USER_ID,
        expectedLeaderIdUserId: LEADER_ID_USER_ID,
        createdAt: NOW,
        expiresAt: '2026-08-28T05:10:00.000Z',
      })),
    };
    const { service } = serviceFixture({ bindings, oauthState });

    await expect(
      service.completeLink({ state: Buffer.alloc(32, 2).toString('base64url'), code: 'old-code' }),
    ).rejects.toMatchObject({ code: 'LEADER_ID_OAUTH_SUPERSEDED', statusCode: 409 });
    expect(bindings.byCatalystUser.get(CATALYST_USER_ID)?.leaderIdUserId).toBe(
      LEADER_ID_USER_ID + 1,
    );
  });
});

describe('Leader-ID Catalyst subscription orchestration', () => {
  it('returns partial per-event results and safely reconciles a retry without another POST', async () => {
    const events = [
      event('existing', 606466),
      event('pending', 606467),
      event('closed', 606468, {
        requiredForSubscription: false,
        registrationOpen: false,
      }),
      event('questionnaire', 606469, {
        requiredForSubscription: false,
        requiresQuestionnaire: true,
      }),
      event('uncertain', 606470, { requiredForSubscription: false }),
    ];
    let listCall = 0;
    const listParticipations = vi.fn(async () => {
      listCall += 1;
      return [
        {
          id: 'existing-participation',
          eventId: 606466,
          moderation: 'approved' as const,
          completed: false,
        },
        ...(listCall >= 3
          ? [
              {
                id: 'eventually-visible-participation',
                eventId: 606470,
                moderation: 'approved' as const,
                completed: false,
              },
            ]
          : []),
      ];
    });
    const createParticipation = vi.fn(async (input: CreateLeaderIdParticipationInput) => {
      if (input.eventId === 606470) {
        throw new LeaderIdApiError({
          message: 'network failure',
          status: null,
          retryable: true,
          externalCode: 'NETWORK',
        });
      }
      return {
        id: `created-${input.eventId}`,
        eventId: input.eventId,
        moderation: 'wait' as const,
        completed: false,
      };
    });
    const client = fakeClient({ listParticipations, createParticipation });
    const registrations = new MemoryRegistrationRepository();
    const rewards = new MemoryRewardIssuer();
    const { service } = serviceFixture({ client, events, registrations, rewards });

    const first = await service.subscribe(CATALYST_USER_ID);

    expect(first).toMatchObject({
      linked: true,
      totalEvents: 5,
      confirmedEvents: 1,
      submittedEvents: 2,
      failedEvents: 3,
      subscriptionComplete: false,
      partial: true,
      reward: { configured: true, points: '250', awarded: true, replayed: false },
    });
    expect(first.results.map((result) => result.status)).toEqual([
      'ALREADY_REGISTERED',
      'PENDING_APPROVAL',
      'REGISTRATION_CLOSED',
      'QUESTIONNAIRE_REQUIRED',
      'FAILED',
    ]);
    expect(createParticipation.mock.calls.map(([input]) => input.eventId)).toEqual([
      606467, 606470,
    ]);
    expect(
      createParticipation.mock.calls.every(([input]) => !('disableNotifications' in input)),
    ).toBe(true);
    expect(rewards.awardCalls).toHaveLength(1);
    expect(rewards.awardCalls[0]).toMatchObject({
      catalystUserId: CATALYST_USER_ID,
      reason: 'LEADER_ID_CATALYST_SUBSCRIPTION',
      idempotencyKey: `leader-id-subscription:LEADER_ID_CATALYST_SUBSCRIPTION:${CATALYST_USER_ID}`,
    });

    const savesAfterFirstAttempt = registrations.saves.length;
    const second = await service.subscribe(CATALYST_USER_ID);

    expect(second).toMatchObject({
      totalEvents: 5,
      confirmedEvents: 2,
      submittedEvents: 3,
      failedEvents: 2,
      subscriptionComplete: false,
      partial: true,
      reward: { awarded: true, replayed: true },
    });
    expect(second.results.at(-1)?.status).toBe('ALREADY_REGISTERED');
    expect(createParticipation).toHaveBeenCalledTimes(2);
    expect(registrations.saves).toHaveLength(savesAfterFirstAttempt + 2);
    expect(registrations.results.get(`${CATALYST_USER_ID}:closed`)?.attemptCount).toBe(1);
    expect(registrations.results.get(`${CATALYST_USER_ID}:questionnaire`)?.attemptCount).toBe(2);
    expect(registrations.results.get(`${CATALYST_USER_ID}:uncertain`)?.attemptCount).toBe(2);
    expect(rewards.awardCalls).toHaveLength(1);
  });

  it('recognizes a manual questionnaire completion before blocking another POST', async () => {
    const questionnaireEvent = event('questionnaire', 606469, {
      requiresQuestionnaire: true,
    });
    let manuallyCompleted = false;
    const listParticipations = vi.fn(async () =>
      manuallyCompleted
        ? [
            {
              id: 'manual-participation',
              eventId: questionnaireEvent.leaderIdEventId,
              moderation: 'approved' as const,
              completed: false,
            },
          ]
        : [],
    );
    const createParticipation = vi.fn();
    const { service } = serviceFixture({
      events: [questionnaireEvent],
      policy: null,
      client: fakeClient({ listParticipations, createParticipation }),
    });

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [{ status: 'QUESTIONNAIRE_REQUIRED' }],
    });
    manuallyCompleted = true;
    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [{ status: 'ALREADY_REGISTERED' }],
      subscriptionComplete: true,
    });
    expect(createParticipation).not.toHaveBeenCalled();
  });

  it('never treats a declined participation as successful when completed is contradictory', async () => {
    const rewards = new MemoryRewardIssuer();
    const createParticipation = vi.fn();
    const { service } = serviceFixture({
      rewards,
      client: fakeClient({
        listParticipations: vi.fn(async () => [
          {
            id: 'contradictory-participation',
            eventId: 606466,
            moderation: 'declined' as const,
            completed: true,
          },
        ]),
        createParticipation,
      }),
    });

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      confirmedEvents: 0,
      submittedEvents: 0,
      subscriptionComplete: false,
      results: [{ status: 'FAILED', errorCode: 'APPLICATION_DECLINED' }],
      reward: { awarded: false },
    });
    expect(createParticipation).not.toHaveBeenCalled();
    expect(rewards.awardCalls).toHaveLength(0);
  });

  it('does not retry a non-retryable failed registration on repeated clicks', async () => {
    const listParticipations = vi.fn(async () => []);
    const createParticipation = vi.fn(async () => {
      throw new LeaderIdApiError({
        message: 'request rejected',
        status: 400,
        retryable: false,
        externalCode: 'INVALID_REQUEST',
      });
    });
    const { service } = serviceFixture({
      client: fakeClient({ listParticipations, createParticipation }),
      policy: null,
    });

    const first = await service.subscribe(CATALYST_USER_ID);
    const second = await service.subscribe(CATALYST_USER_ID);

    expect(first.results[0]).toMatchObject({ status: 'FAILED', retryable: false });
    expect(second.results[0]).toMatchObject({ status: 'FAILED', retryable: false });
    expect(createParticipation).toHaveBeenCalledOnce();
    expect(listParticipations).toHaveBeenCalledTimes(3);
  });

  it('finalizes a definite 401 claim when reauthorization is required', async () => {
    const bindings = new MemoryBindingRepository(
      linkedBinding({ accessToken: 'expired-token', leaderIdUserId: LEADER_ID_USER_ID }),
    );
    const createParticipation = vi.fn(async () => {
      throw new LeaderIdApiError({
        message: 'unauthorized',
        status: 401,
        retryable: false,
        externalCode: 'UNAUTHORIZED',
      });
    });
    const registrations = new MemoryRegistrationRepository();
    const { service } = serviceFixture({
      bindings,
      registrations,
      client: fakeClient({ listParticipations: vi.fn(async () => []), createParticipation }),
      policy: null,
    });

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [
        {
          status: 'FAILED',
          retryable: true,
          errorCode: 'LEADER_ID_REAUTH_REQUIRED',
        },
      ],
    });
    expect(createParticipation).toHaveBeenCalledOnce();
    expect(registrations.results.get(`${CATALYST_USER_ID}:event-606466`)).not.toHaveProperty(
      'claimToken',
    );
  });

  it('finalizes a definite POST rejection when reconciliation itself requires reauthorization', async () => {
    let listCall = 0;
    const listParticipations = vi.fn(async () => {
      listCall += 1;
      if (listCall === 1 || listCall >= 3) return [];
      throw new LeaderIdApiError({
        message: 'expired while reconciling',
        status: 401,
        retryable: false,
        externalCode: 'UNAUTHORIZED',
      });
    });
    const createParticipation = vi.fn(async () => {
      throw new LeaderIdApiError({
        message: 'request rejected',
        status: 400,
        retryable: false,
        externalCode: 'INVALID_REQUEST',
      });
    });
    const refreshAccessToken = vi.fn(async () => {
      throw new LeaderIdApiError({
        message: 'refresh token rejected',
        status: 401,
        retryable: false,
        externalCode: 'UNAUTHORIZED',
      });
    });
    const registrations = new MemoryRegistrationRepository();
    const { service } = serviceFixture({
      registrations,
      client: fakeClient({ listParticipations, createParticipation, refreshAccessToken }),
      policy: null,
    });

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [
        {
          status: 'FAILED',
          retryable: false,
          errorCode: 'LEADER_ID_INVALID_REQUEST',
        },
      ],
    });
    expect(registrations.results.get(`${CATALYST_USER_ID}:event-606466`)).not.toHaveProperty(
      'claimToken',
    );

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [{ status: 'FAILED', errorCode: 'LEADER_ID_INVALID_REQUEST' }],
    });
    expect(createParticipation).toHaveBeenCalledOnce();
  });

  it('reports a changed binding or event snapshot when a lost claim has no authoritative row', async () => {
    const registrations = new MemoryRegistrationRepository();
    vi.spyOn(registrations, 'claimAttempt').mockResolvedValue(false);
    const { service } = serviceFixture({ registrations, policy: null });

    await expect(service.subscribe(CATALYST_USER_ID)).rejects.toMatchObject({
      code: 'LEADER_ID_STATE_CHANGED',
      statusCode: 409,
    });
  });

  it('uses reconcile-only retries after an ambiguous POST outcome', async () => {
    const listParticipations = vi.fn(async () => []);
    const createParticipation = vi.fn(async () => {
      throw new LeaderIdApiError({
        message: 'connection lost after request send',
        status: null,
        retryable: true,
        externalCode: 'NETWORK',
      });
    });
    const registrations = new MemoryRegistrationRepository();
    const { service } = serviceFixture({
      client: fakeClient({ listParticipations, createParticipation }),
      registrations,
      policy: null,
    });

    const first = await service.subscribe(CATALYST_USER_ID);
    const savesAfterFirstAttempt = registrations.saves.length;
    const second = await service.subscribe(CATALYST_USER_ID);

    expect(first.results[0]).toMatchObject({
      status: 'FAILED',
      retryable: true,
      errorCode: 'LEADER_ID_POST_OUTCOME_UNKNOWN',
    });
    expect(second.results[0]).toMatchObject({
      status: 'FAILED',
      retryable: true,
      errorCode: 'LEADER_ID_POST_OUTCOME_UNKNOWN',
    });
    expect(createParticipation).toHaveBeenCalledOnce();
    expect(listParticipations).toHaveBeenCalledTimes(3);
    expect(registrations.saves).toHaveLength(savesAfterFirstAttempt);
  });

  it('allows only one external POST when two workers overlap after a lease loss', async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createParticipation = vi.fn(async (input: CreateLeaderIdParticipationInput) => {
      await createGate;
      return {
        id: `participation-${input.eventId}`,
        eventId: input.eventId,
        moderation: 'approved' as const,
        completed: false,
      };
    });
    const registrations = new MemoryRegistrationRepository();
    const { service } = serviceFixture({
      client: fakeClient({
        listParticipations: vi.fn(async () => []),
        createParticipation,
      }),
      registrations,
      policy: null,
    });

    const first = service.subscribe(CATALYST_USER_ID);
    await vi.waitFor(() => expect(createParticipation).toHaveBeenCalledOnce());
    const second = service.subscribe(CATALYST_USER_ID);
    await expect(second).resolves.toMatchObject({
      results: [{ errorCode: 'LEADER_ID_POST_OUTCOME_UNKNOWN' }],
    });
    releaseCreate();

    await expect(first).resolves.toMatchObject({
      results: [{ status: 'REGISTERED' }],
    });
    expect(createParticipation).toHaveBeenCalledOnce();
    expect(registrations.results.get(`${CATALYST_USER_ID}:event-606466`)).not.toHaveProperty(
      'claimToken',
    );
  });

  it('does not let a stale GET failure clear another worker durable claim', async () => {
    let rejectStaleRead!: (error: unknown) => void;
    const staleRead = new Promise<never>((_resolve, reject) => {
      rejectStaleRead = reject;
    });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let listCall = 0;
    const listParticipations = vi.fn(async () => {
      listCall += 1;
      if (listCall === 1) return staleRead;
      return [];
    });
    const createParticipation = vi.fn(async (input: CreateLeaderIdParticipationInput) => {
      await createGate;
      return {
        id: `participation-${input.eventId}`,
        eventId: input.eventId,
        moderation: 'approved' as const,
        completed: false,
      };
    });
    const registrations = new MemoryRegistrationRepository();
    const client = fakeClient({ listParticipations, createParticipation });
    const staleWorker = serviceFixture({ client, registrations, policy: null }).service;
    const postingWorker = serviceFixture({ client, registrations, policy: null }).service;

    const staleRequest = staleWorker.subscribe(CATALYST_USER_ID);
    await vi.waitFor(() => expect(listParticipations).toHaveBeenCalledOnce());
    const postingRequest = postingWorker.subscribe(CATALYST_USER_ID);
    await vi.waitFor(() => expect(createParticipation).toHaveBeenCalledOnce());
    rejectStaleRead(
      new LeaderIdApiError({
        message: 'stale GET failed',
        status: null,
        retryable: true,
        externalCode: 'NETWORK',
      }),
    );

    await expect(staleRequest).resolves.toMatchObject({
      results: [{ errorCode: 'LEADER_ID_POST_OUTCOME_UNKNOWN' }],
    });
    expect(registrations.results.get(`${CATALYST_USER_ID}:event-606466`)?.claimToken).toBeTruthy();
    releaseCreate();
    await expect(postingRequest).resolves.toMatchObject({
      results: [{ status: 'REGISTERED' }],
    });
    expect(createParticipation).toHaveBeenCalledOnce();
  });

  it('keeps a crash-left durable claim in GET-only recovery mode', async () => {
    const registrations = new MemoryRegistrationRepository();
    registrations.results.set(`${CATALYST_USER_ID}:event-606466`, {
      catalystUserId: CATALYST_USER_ID,
      leaderIdUserId: LEADER_ID_USER_ID,
      catalystEventId: 'event-606466',
      leaderIdEventId: 606466,
      status: 'FAILED',
      retryable: true,
      errorCode: leaderIdPostOutcomeUnknown,
      attemptCount: 1,
      claimToken: '8920efee-6ec9-4a73-8c27-6633a37c4991',
      updatedAt: NOW,
    });
    const createParticipation = vi.fn();
    const listParticipations = vi.fn(async () => []);
    const { service } = serviceFixture({
      client: fakeClient({ listParticipations, createParticipation }),
      registrations,
      events: [
        event('event-606466', 606466, {
          registrationOpen: false,
          requiresQuestionnaire: true,
        }),
      ],
      policy: null,
    });

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [{ status: 'FAILED', errorCode: 'LEADER_ID_POST_OUTCOME_UNKNOWN' }],
    });
    expect(listParticipations).toHaveBeenCalledOnce();
    expect(createParticipation).not.toHaveBeenCalled();
  });

  it('resolves a crash-left claim through authoritative GET without another POST', async () => {
    const registrations = new MemoryRegistrationRepository();
    registrations.results.set(`${CATALYST_USER_ID}:event-606466`, {
      catalystUserId: CATALYST_USER_ID,
      leaderIdUserId: LEADER_ID_USER_ID,
      catalystEventId: 'event-606466',
      leaderIdEventId: 606466,
      status: 'FAILED',
      retryable: true,
      errorCode: leaderIdPostOutcomeUnknown,
      attemptCount: 1,
      claimToken: '586b09d0-7bca-4e89-a1c3-fe1fbb53a0b8',
      updatedAt: NOW,
    });
    const createParticipation = vi.fn();
    const { service } = serviceFixture({
      registrations,
      client: fakeClient({
        listParticipations: vi.fn(async () => [
          {
            id: 'reconciled-participation',
            eventId: 606466,
            moderation: 'approved' as const,
            completed: false,
          },
        ]),
        createParticipation,
      }),
      policy: null,
    });

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [{ status: 'ALREADY_REGISTERED' }],
    });
    expect(createParticipation).not.toHaveBeenCalled();
    expect(registrations.results.get(`${CATALYST_USER_ID}:event-606466`)).not.toHaveProperty(
      'claimToken',
    );
  });

  it.each([
    ['a previous Leader-ID user', LEADER_ID_USER_ID + 1, 606466],
    ['a previous external event mapping', LEADER_ID_USER_ID, 606465],
  ])(
    'does not reuse successful registration from %s',
    async (_label, leaderIdUserId, leaderIdEventId) => {
      const registrations = new MemoryRegistrationRepository();
      await registrations.saveResult(
        {
          catalystUserId: CATALYST_USER_ID,
          leaderIdUserId,
          catalystEventId: 'event-606466',
          leaderIdEventId,
          status: 'REGISTERED',
          retryable: false,
          attemptCount: 4,
          updatedAt: NOW,
        },
        null,
      );
      const createParticipation = vi.fn(async (input: CreateLeaderIdParticipationInput) => ({
        id: 'new-current-participation',
        eventId: input.eventId,
        moderation: 'approved' as const,
        completed: false,
      }));
      const { service } = serviceFixture({
        registrations,
        client: fakeClient({ listParticipations: vi.fn(async () => []), createParticipation }),
        policy: null,
      });

      await expect(service.getStatus(CATALYST_USER_ID)).resolves.toMatchObject({
        submittedEvents: 0,
        subscriptionComplete: false,
      });
      await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
        results: [{ status: 'REGISTERED', leaderIdEventId: 606466 }],
      });
      expect(createParticipation).toHaveBeenCalledOnce();
    },
  );

  it('replaces a stale snapshot when GET proves the current identity already participates', async () => {
    const registrations = new MemoryRegistrationRepository();
    await registrations.saveResult(
      {
        catalystUserId: CATALYST_USER_ID,
        leaderIdUserId: LEADER_ID_USER_ID + 1,
        catalystEventId: 'event-606466',
        leaderIdEventId: 606465,
        status: 'REGISTERED',
        retryable: false,
        attemptCount: 4,
        updatedAt: NOW,
      },
      null,
    );
    const createParticipation = vi.fn();
    const { service } = serviceFixture({
      registrations,
      client: fakeClient({
        listParticipations: vi.fn(async () => [
          {
            id: 'current-participation',
            eventId: 606466,
            moderation: 'approved' as const,
            completed: false,
          },
        ]),
        createParticipation,
      }),
      policy: null,
    });

    await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
      results: [{ status: 'ALREADY_REGISTERED', leaderIdEventId: 606466 }],
    });
    expect(createParticipation).not.toHaveBeenCalled();
    expect(registrations.results.get(`${CATALYST_USER_ID}:event-606466`)).toMatchObject({
      leaderIdUserId: LEADER_ID_USER_ID,
      leaderIdEventId: 606466,
      status: 'ALREADY_REGISTERED',
    });
  });

  it.each([
    ['QuestionnaireRequired', 'QUESTIONNAIRE_REQUIRED'],
    ['EventRegistrationClosed', 'REGISTRATION_CLOSED'],
  ] as const)(
    'normalizes the official %s error code after reconciliation',
    async (code, status) => {
      const client = fakeClient({
        listParticipations: vi.fn(async () => []),
        createParticipation: vi.fn(async () => {
          throw new LeaderIdApiError({
            message: 'request rejected',
            status: 409,
            retryable: false,
            externalCode: code,
          });
        }),
      });
      const { service } = serviceFixture({ client, policy: null });

      await expect(service.subscribe(CATALYST_USER_ID)).resolves.toMatchObject({
        results: [{ status, retryable: false }],
      });
    },
  );

  it('loads a reload-safe snapshot and marks a newly active unattempted event incomplete', async () => {
    const registrations = new MemoryRegistrationRepository();
    await registrations.saveResult(
      {
        catalystUserId: CATALYST_USER_ID,
        leaderIdUserId: LEADER_ID_USER_ID,
        catalystEventId: 'existing',
        leaderIdEventId: 606466,
        status: 'REGISTERED',
        retryable: false,
        attemptCount: 1,
        updatedAt: NOW,
      },
      null,
    );
    const rewards = new MemoryRewardIssuer();
    await rewards.awardOnce({
      catalystUserId: CATALYST_USER_ID,
      reason: defaultPolicy.reason,
      points: defaultPolicy.points,
      idempotencyKey: 'existing-reward',
      qualifyingEventIds: ['existing'],
    });
    const { service } = serviceFixture({
      registrations,
      rewards,
      events: [event('existing', 606466), event('new-event', 606467)],
    });

    await expect(service.getStatus(CATALYST_USER_ID)).resolves.toMatchObject({
      linked: true,
      leaderIdUserId: LEADER_ID_USER_ID,
      totalEvents: 2,
      confirmedEvents: 1,
      submittedEvents: 1,
      failedEvents: 0,
      subscriptionComplete: false,
      partial: true,
      reward: { configured: true, points: '250', awarded: true },
    });
  });

  it('shows the immutable awarded amount after the current reward is changed or disabled', async () => {
    const rewards = new MemoryRewardIssuer();
    await rewards.awardOnce({
      catalystUserId: CATALYST_USER_ID,
      reason: defaultPolicy.reason,
      points: 100n,
      idempotencyKey: 'historic-reward',
      qualifyingEventIds: ['event-606466'],
    });
    const { service } = serviceFixture({ rewards, policy: null });

    await expect(service.getStatus(CATALYST_USER_ID)).resolves.toMatchObject({
      reward: { configured: false, points: '100', awarded: true },
    });
  });
});
