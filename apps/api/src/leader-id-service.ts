import { randomUUID } from 'node:crypto';
import { AppError, asError } from '@cpi/shared';
import { LeaderIdApiError, isLeaderIdApiError } from './leader-id-client';
import { leaderIdPostOutcomeUnknown, leaderIdSubscriptionRewardReason } from './leader-id-contract';
import type {
  CatalystLeaderIdEvent,
  CatalystLeaderIdEventRegistry,
  LeaderIdApiClient,
  LeaderIdBinding,
  LeaderIdBindingRepository,
  LeaderIdEventResult,
  LeaderIdOAuthStateManager,
  LeaderIdParticipation,
  LeaderIdQuestionnaireAnswerProvider,
  LeaderIdRegistrationRepository,
  LeaderIdRegistrationStatus,
  LeaderIdRewardGrant,
  LeaderIdRewardIssuer,
  LeaderIdRewardPolicy,
  LeaderIdRewardPolicyProvider,
  LeaderIdStatusSnapshot,
  LeaderIdSubscriptionSummary,
  LeaderIdTokenCipher,
  LeaderIdTokenSet,
  StoredLeaderIdRegistrationResult,
} from './leader-id-contract';

const DEFAULT_SUBMITTED_STATUSES = new Set<LeaderIdRegistrationStatus>([
  'REGISTERED',
  'ALREADY_REGISTERED',
  'PENDING_APPROVAL',
]);
const CONFIRMED_STATUSES = new Set<LeaderIdRegistrationStatus>([
  'REGISTERED',
  'ALREADY_REGISTERED',
]);

type Sleep = (milliseconds: number) => Promise<void>;

export interface LeaderIdServiceOptions {
  client: LeaderIdApiClient;
  oauthState: LeaderIdOAuthStateManager;
  tokenCipher: LeaderIdTokenCipher;
  bindings: LeaderIdBindingRepository;
  events: CatalystLeaderIdEventRegistry;
  registrations: LeaderIdRegistrationRepository;
  rewardPolicies: LeaderIdRewardPolicyProvider;
  rewards: LeaderIdRewardIssuer;
  questionnaireAnswers?: LeaderIdQuestionnaireAnswerProvider;
  serverCredentials: {
    clientId: string;
    clientSecret: string;
  };
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scope?: string;
  };
  now?: () => Date;
  sleep?: Sleep;
  maximumReadAttempts?: number;
}

interface MutableUserTokenContext {
  binding: LeaderIdBinding;
  tokens: LeaderIdTokenSet;
}

interface PreparedEvent {
  event: CatalystLeaderIdEvent;
  storedPrevious: StoredLeaderIdRegistrationResult | null;
  previous: StoredLeaderIdRegistrationResult | null;
  quizAnswerId: string | null;
  result?: StoredLeaderIdRegistrationResult;
}

function sortEvents(events: CatalystLeaderIdEvent[]): CatalystLeaderIdEvent[] {
  return [...events]
    .filter((event) => event.active)
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.leaderIdEventId - right.leaderIdEventId,
    );
}

function moderationStatus(
  participation: LeaderIdParticipation,
  existing: boolean,
): LeaderIdRegistrationStatus {
  // The official schema exposes `moderation` and `completed` independently. A declined
  // application must never qualify for a reward even if Leader-ID returns a contradictory
  // completed flag.
  if (participation.moderation === 'declined') return 'FAILED';
  if (participation.moderation === 'approved' || participation.completed) {
    return existing ? 'ALREADY_REGISTERED' : 'REGISTERED';
  }
  if (participation.moderation === 'wait') return 'PENDING_APPROVAL';
  return 'FAILED';
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (isLeaderIdApiError(error)) {
    if (error.externalCode) return `LEADER_ID_${error.externalCode}`;
    if (error.status !== null) return `LEADER_ID_HTTP_${error.status}`;
    return 'LEADER_ID_NETWORK';
  }
  return 'LEADER_ID_UNEXPECTED';
}

function normalizedFailureStatus(error: unknown): LeaderIdRegistrationStatus {
  if (!isLeaderIdApiError(error)) return 'FAILED';
  if (error.status === 404) return 'EVENT_NOT_AVAILABLE';
  if (!error.externalCode) return 'FAILED';
  const tokens = error.externalCode
    .replace(/([a-z\d])([A-Z])/gu, '$1_$2')
    .toUpperCase()
    .split(/[_.-]+/u);
  if (tokens.some((token) => token === 'QUIZ' || token === 'QUESTIONNAIRE' || token === 'FORM')) {
    return 'QUESTIONNAIRE_REQUIRED';
  }
  if (tokens.includes('CLOSED')) return 'REGISTRATION_CLOSED';
  return 'FAILED';
}

function isUnauthorized(error: unknown): boolean {
  return isLeaderIdApiError(error) && error.status === 401;
}

function isUncertainPostFailure(error: unknown): boolean {
  return (
    isLeaderIdApiError(error) &&
    (error.status === null ||
      error.status === 408 ||
      (error.status !== null && error.status >= 500))
  );
}

function storedToEventResult(
  stored: StoredLeaderIdRegistrationResult,
  event: CatalystLeaderIdEvent,
): LeaderIdEventResult {
  return {
    catalystEventId: event.id,
    leaderIdEventId: event.leaderIdEventId,
    title: event.title,
    requiredForSubscription: event.requiredForSubscription,
    status: stored.status,
    retryable: stored.retryable,
    ...(stored.officialParticipationId === undefined
      ? {}
      : { officialParticipationId: stored.officialParticipationId }),
    ...(stored.officialModeration === undefined
      ? {}
      : { officialModeration: stored.officialModeration }),
    ...(stored.errorCode === undefined ? {} : { errorCode: stored.errorCode }),
  };
}

function hasCurrentSnapshot(
  result: StoredLeaderIdRegistrationResult,
  binding: LeaderIdBinding,
  event: CatalystLeaderIdEvent,
): boolean {
  return (
    result.catalystUserId === binding.catalystUserId &&
    result.leaderIdUserId === binding.leaderIdUserId &&
    result.catalystEventId === event.id &&
    result.leaderIdEventId === event.leaderIdEventId
  );
}

function retryableStoredResult(
  previous: StoredLeaderIdRegistrationResult | null,
  event: CatalystLeaderIdEvent,
): boolean {
  if (!previous) return true;
  if (previous.status === 'FAILED') return previous.retryable;
  if (previous.status === 'REGISTRATION_CLOSED') return event.registrationOpen;
  if (previous.status === 'QUESTIONNAIRE_REQUIRED') return true;
  return false;
}

function rewardIdempotencyKey(catalystUserId: string, reason: string): string {
  return `leader-id-subscription:${reason}:${catalystUserId}`;
}

export class LeaderIdService {
  readonly #client: LeaderIdApiClient;
  readonly #oauthState: LeaderIdOAuthStateManager;
  readonly #tokenCipher: LeaderIdTokenCipher;
  readonly #bindings: LeaderIdBindingRepository;
  readonly #events: CatalystLeaderIdEventRegistry;
  readonly #registrations: LeaderIdRegistrationRepository;
  readonly #rewardPolicies: LeaderIdRewardPolicyProvider;
  readonly #rewards: LeaderIdRewardIssuer;
  readonly #questionnaireAnswers?: LeaderIdQuestionnaireAnswerProvider;
  readonly #serverCredentials: LeaderIdServiceOptions['serverCredentials'];
  readonly #oauth: LeaderIdServiceOptions['oauth'];
  readonly #now: () => Date;
  readonly #sleep: Sleep;
  readonly #maximumReadAttempts: number;

  constructor(options: LeaderIdServiceOptions) {
    this.#client = options.client;
    this.#oauthState = options.oauthState;
    this.#tokenCipher = options.tokenCipher;
    this.#bindings = options.bindings;
    this.#events = options.events;
    this.#registrations = options.registrations;
    this.#rewardPolicies = options.rewardPolicies;
    this.#rewards = options.rewards;
    if (options.questionnaireAnswers !== undefined) {
      this.#questionnaireAnswers = options.questionnaireAnswers;
    }
    this.#serverCredentials = options.serverCredentials;
    this.#oauth = options.oauth;
    if (!this.#serverCredentials.clientId || !this.#serverCredentials.clientSecret) {
      throw new Error('Leader-ID server credential configuration is incomplete');
    }
    if (!this.#oauth.clientId || !this.#oauth.clientSecret || !this.#oauth.redirectUri) {
      throw new Error('Leader-ID OAuth configuration is incomplete');
    }
    this.#now = options.now ?? (() => new Date());
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#maximumReadAttempts = options.maximumReadAttempts ?? 3;
    if (
      !Number.isInteger(this.#maximumReadAttempts) ||
      this.#maximumReadAttempts < 1 ||
      this.#maximumReadAttempts > 5
    ) {
      throw new Error('Leader-ID read attempts must be between 1 and 5');
    }
  }

  /**
   * A typed ID is checked for existence, but ownership is established only by the OAuth callback.
   */
  async beginLink(input: {
    catalystUserId: string;
    expectedLeaderIdUserId: number;
  }): Promise<{ authorizationUrl: string }> {
    if (!Number.isSafeInteger(input.expectedLeaderIdUserId) || input.expectedLeaderIdUserId <= 0) {
      throw new AppError('LEADER_ID_INVALID', 'Проверьте Leader-ID', 400);
    }
    try {
      const applicationTokens = await this.#retryRead(() =>
        this.#client.exchangeClientCredentials({
          clientId: this.#serverCredentials.clientId,
          clientSecret: this.#serverCredentials.clientSecret,
        }),
      );
      const user = await this.#retryRead(() =>
        this.#client.getUser(input.expectedLeaderIdUserId, applicationTokens.accessToken),
      );
      if (user.id !== input.expectedLeaderIdUserId) {
        throw new AppError('LEADER_ID_NOT_FOUND', 'Профиль Leader-ID не найден', 404);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isLeaderIdApiError(error) && error.status === 404) {
        throw new AppError('LEADER_ID_NOT_FOUND', 'Профиль Leader-ID не найден', 404);
      }
      throw new AppError(
        'LEADER_ID_LOOKUP_UNAVAILABLE',
        'Не удалось проверить Leader-ID. Повторите попытку.',
        502,
        { retryable: isLeaderIdApiError(error) ? error.retryable : false },
      );
    }

    const state = await this.#oauthState.issue(input);
    return {
      authorizationUrl: this.#client.createAuthorizationUrl({
        clientId: this.#oauth.clientId,
        redirectUri: this.#oauth.redirectUri,
        state,
        ...(this.#oauth.scope === undefined ? {} : { scope: this.#oauth.scope }),
      }),
    };
  }

  async cancelLink(state: string): Promise<void> {
    await this.#oauthState.consume(state);
  }

  async completeLink(input: { state: string; code: string }): Promise<{
    catalystUserId: string;
    leaderIdUserId: number;
  }> {
    const pending = await this.#oauthState.consume(input.state);
    let tokens: LeaderIdTokenSet;
    try {
      // Authorization codes can be single-use, so this exchange is deliberately not auto-retried.
      tokens = await this.#client.exchangeAuthorizationCode({
        clientId: this.#oauth.clientId,
        clientSecret: this.#oauth.clientSecret,
        code: input.code,
      });
    } catch {
      throw new AppError(
        'LEADER_ID_OAUTH_FAILED',
        'Не удалось подтвердить авторизацию Leader-ID',
        502,
      );
    }
    if (tokens.leaderIdUserId === undefined) {
      throw new AppError(
        'LEADER_ID_OAUTH_ID_MISSING',
        'Leader-ID не вернул идентификатор профиля',
        502,
      );
    }
    if (tokens.leaderIdUserId !== pending.expectedLeaderIdUserId) {
      throw new AppError(
        'LEADER_ID_OWNERSHIP_MISMATCH',
        'Авторизован другой профиль Leader-ID',
        409,
      );
    }

    try {
      const verified = await this.#retryRead(() =>
        this.#client.getUser(tokens.leaderIdUserId!, tokens.accessToken),
      );
      if (verified.id !== tokens.leaderIdUserId) {
        throw new Error('OAuth user lookup returned a different profile');
      }
    } catch {
      throw new AppError(
        'LEADER_ID_OAUTH_PROFILE_UNAVAILABLE',
        'Не удалось подтвердить профиль Leader-ID',
        502,
      );
    }

    const normalizedTokens: LeaderIdTokenSet = {
      ...tokens,
      leaderIdUserId: tokens.leaderIdUserId,
    };
    const binding: LeaderIdBinding = {
      catalystUserId: pending.catalystUserId,
      leaderIdUserId: tokens.leaderIdUserId,
      encryptedTokens: this.#tokenCipher.encrypt(normalizedTokens, pending.catalystUserId),
      // The state issuance time is the binding generation. An older OAuth tab that finishes
      // later must not replace a newer verified binding and its refresh token.
      linkedAt: pending.createdAt,
      ...(tokens.expiresAt === undefined ? {} : { tokenExpiresAt: tokens.expiresAt }),
    };
    // Do not place the already-consumed single-use OAuth code behind the subscription lease.
    // The database uniqueness constraint remains the authoritative cross-process ownership guard.
    const claimed = await this.#bindings.findByLeaderIdUserId(tokens.leaderIdUserId);
    if (claimed && claimed.catalystUserId !== pending.catalystUserId) {
      throw new AppError(
        'LEADER_ID_ALREADY_LINKED',
        'Этот Leader-ID уже подключён к другому аккаунту Catalyst',
        409,
      );
    }
    try {
      const applied = await this.#bindings.upsertVerifiedBinding(binding);
      if (!applied) {
        throw new AppError(
          'LEADER_ID_OAUTH_SUPERSEDED',
          'Запрос на подключение Leader-ID устарел или дождитесь завершения текущей регистрации',
          409,
        );
      }
    } catch (error) {
      const concurrentOwner = await this.#bindings.findByLeaderIdUserId(tokens.leaderIdUserId);
      if (concurrentOwner && concurrentOwner.catalystUserId !== pending.catalystUserId) {
        throw new AppError(
          'LEADER_ID_ALREADY_LINKED',
          'Этот Leader-ID уже подключён к другому аккаунту Catalyst',
          409,
        );
      }
      throw error;
    }
    const current = await this.#bindings.findByCatalystUserId(pending.catalystUserId);
    if (!current || current.leaderIdUserId !== tokens.leaderIdUserId) {
      throw new AppError(
        'LEADER_ID_OAUTH_SUPERSEDED',
        'Запрос на подключение Leader-ID устарел',
        409,
      );
    }
    return {
      catalystUserId: pending.catalystUserId,
      leaderIdUserId: tokens.leaderIdUserId,
    };
  }

  async subscribe(catalystUserId: string): Promise<LeaderIdSubscriptionSummary> {
    return this.#registrations.withUserLock(catalystUserId, async () => {
      const binding = await this.#bindings.findByCatalystUserId(catalystUserId);
      if (!binding) {
        throw new AppError('LEADER_ID_NOT_LINKED', 'Сначала подключите профиль Leader-ID', 409);
      }
      return this.#subscribeLocked(binding);
    });
  }

  async getStatus(catalystUserId: string): Promise<LeaderIdStatusSnapshot> {
    const [binding, events, stored, policy] = await Promise.all([
      this.#bindings.findByCatalystUserId(catalystUserId),
      this.#events.listActiveEvents().then(sortEvents),
      this.#registrations.listResults(catalystUserId),
      this.#rewardPolicies.getPolicy(),
    ]);
    const byEvent = new Map(
      stored
        .filter((result) => binding !== null && result.leaderIdUserId === binding.leaderIdUserId)
        .map((result) => [result.catalystEventId, result]),
    );
    const results = events.flatMap((event) => {
      const result = byEvent.get(event.id);
      return result?.leaderIdEventId === event.leaderIdEventId
        ? [storedToEventResult(result, event)]
        : [];
    });
    const confirmedEvents = results.filter((result) =>
      CONFIRMED_STATUSES.has(result.status),
    ).length;
    const submittedEvents = results.filter((result) =>
      DEFAULT_SUBMITTED_STATUSES.has(result.status),
    ).length;
    const failedEvents = results.filter(
      (result) => !DEFAULT_SUBMITTED_STATUSES.has(result.status),
    ).length;
    const statusByEvent = new Map(results.map((result) => [result.catalystEventId, result.status]));
    const subscriptionComplete =
      binding !== null &&
      events.length > 0 &&
      events.every((event) =>
        DEFAULT_SUBMITTED_STATUSES.has(statusByEvent.get(event.id) ?? 'FAILED'),
      );
    const grant = await this.#rewards.findGrant(
      catalystUserId,
      policy?.reason ?? leaderIdSubscriptionRewardReason,
    );
    return {
      linked: binding !== null,
      ...(binding === null ? {} : { leaderIdUserId: binding.leaderIdUserId }),
      totalEvents: events.length,
      confirmedEvents,
      submittedEvents,
      failedEvents,
      subscriptionComplete,
      partial: submittedEvents > 0 && !subscriptionComplete,
      results,
      reward: {
        configured: policy?.active === true,
        points: (grant?.points ?? (policy?.active === true ? policy.points : 0n)).toString(),
        awarded: grant?.awarded === true || grant?.replayed === true,
      },
    };
  }

  async #subscribeLocked(binding: LeaderIdBinding): Promise<LeaderIdSubscriptionSummary> {
    const events = sortEvents(await this.#events.listActiveEvents());
    if (events.length === 0) {
      throw new AppError(
        'LEADER_ID_EVENTS_UNAVAILABLE',
        'Список мероприятий Catalyst пока пуст',
        503,
      );
    }
    const context: MutableUserTokenContext = {
      binding,
      tokens: this.#tokenCipher.decrypt(binding.encryptedTokens, binding.catalystUserId),
    };
    if (
      context.tokens.leaderIdUserId !== undefined &&
      context.tokens.leaderIdUserId !== binding.leaderIdUserId
    ) {
      throw new AppError(
        'LEADER_ID_BINDING_INVALID',
        'Подключение Leader-ID повреждено. Подключите профиль заново.',
        409,
      );
    }
    await this.#refreshIfExpiring(context);

    const prepared = await Promise.all(
      events.map(async (event): Promise<PreparedEvent> => {
        const storedPrevious = await this.#registrations.findResult(
          binding.catalystUserId,
          event.id,
        );
        const previous =
          storedPrevious?.leaderIdUserId === binding.leaderIdUserId &&
          storedPrevious.leaderIdEventId === event.leaderIdEventId
            ? storedPrevious
            : null;
        const quizAnswerId =
          event.requiresQuestionnaire && this.#questionnaireAnswers
            ? await this.#questionnaireAnswers.findQuizAnswerId({
                catalystUserId: binding.catalystUserId,
                leaderIdUserId: binding.leaderIdUserId,
                event,
              })
            : null;
        return { event, storedPrevious, previous, quizAnswerId };
      }),
    );

    for (const item of prepared) {
      if (item.previous && CONFIRMED_STATUSES.has(item.previous.status)) {
        item.result = item.previous;
      }
    }

    const actionable = prepared.filter((item) => item.result === undefined);
    let remote = new Map<number, LeaderIdParticipation>();
    if (actionable.length > 0) {
      try {
        remote = await this.#loadParticipationMap(context);
      } catch (error) {
        if (error instanceof AppError) throw error;
        for (const item of actionable) {
          // A read outage must not erase a durable pending/closed/unknown result. Existing rows
          // remain visible and can be safely reconciled by GET on the next user retry.
          if (item.previous) {
            item.result = item.previous;
            continue;
          }
          item.result = await this.#persistResult({
            binding,
            event: item.event,
            previous: item.storedPrevious,
            status: 'FAILED',
            retryable: isLeaderIdApiError(error) ? error.retryable : false,
            errorCode: safeErrorCode(error),
          });
        }
      }
    }

    for (const item of actionable) {
      if (item.result) continue;
      const existing = remote.get(item.event.leaderIdEventId);
      if (existing) {
        item.result = await this.#persistParticipationResult({
          binding,
          event: item.event,
          previous: item.storedPrevious,
          participation: existing,
          existing: true,
        });
        continue;
      }
      // Only a positive authoritative GET may resolve another worker's same-snapshot UNKNOWN
      // claim. Local registry/questionnaire decisions must leave that durable fence untouched.
      if (item.previous?.errorCode === leaderIdPostOutcomeUnknown) {
        item.result = item.previous;
        continue;
      }
      // Non-retryable local outcomes are still reconciled through GET above, but never cause
      // another external POST merely because the user clicked again.
      if (item.previous && !retryableStoredResult(item.previous, item.event)) {
        item.result = item.previous;
        continue;
      }
      // Even when the registry says registration is closed or a questionnaire is required, the
      // read preflight above runs first. This lets a user who completed an unavoidable external
      // step be recognized as already registered instead of being trapped in a local error state.
      if (!item.event.registrationOpen) {
        item.result = await this.#persistResult({
          binding,
          event: item.event,
          previous: item.storedPrevious,
          status: 'REGISTRATION_CLOSED',
          retryable: false,
          errorCode: 'REGISTRATION_CLOSED',
        });
        continue;
      }
      if (item.event.requiresQuestionnaire && !item.quizAnswerId) {
        item.result = await this.#persistResult({
          binding,
          event: item.event,
          previous: item.storedPrevious,
          status: 'QUESTIONNAIRE_REQUIRED',
          retryable: false,
          errorCode: 'QUESTIONNAIRE_REQUIRED',
        });
        continue;
      }
      item.result = await this.#createOnceAndReconcile({
        context,
        event: item.event,
        previous: item.storedPrevious,
        quizAnswerId: item.quizAnswerId,
      });
    }

    const storedResults = prepared.map((item) => {
      if (!item.result) throw new Error(`Leader-ID event ${item.event.id} has no result`);
      return item.result;
    });
    const eventResults = storedResults.map((stored, index) =>
      storedToEventResult(stored, events[index]!),
    );
    const policy = await this.#rewardPolicies.getPolicy();
    const reward = await this.#resolveReward(binding.catalystUserId, events, eventResults, policy);
    return this.#summarize(binding, events, eventResults, policy, reward);
  }

  async #createOnceAndReconcile(input: {
    context: MutableUserTokenContext;
    event: CatalystLeaderIdEvent;
    previous: StoredLeaderIdRegistrationResult | null;
    quizAnswerId: string | null;
  }): Promise<StoredLeaderIdRegistrationResult> {
    const expectedAttemptCount = input.previous?.attemptCount ?? 0;
    const claim = this.#buildResult(
      {
        binding: input.context.binding,
        event: input.event,
        previous: input.previous,
        status: 'FAILED',
        retryable: true,
        errorCode: leaderIdPostOutcomeUnknown,
      },
      expectedAttemptCount + 1,
      randomUUID(),
    );
    const ownsClaim = await this.#registrations.claimAttempt(claim, expectedAttemptCount);
    if (!ownsClaim) {
      const authoritative = await this.#registrations.findResult(
        input.context.binding.catalystUserId,
        input.event.id,
      );
      if (
        !authoritative ||
        !hasCurrentSnapshot(authoritative, input.context.binding, input.event)
      ) {
        throw new AppError(
          'LEADER_ID_STATE_CHANGED',
          'Подключение Leader-ID или список мероприятий изменился. Повторите действие.',
          409,
        );
      }
      return authoritative;
    }
    try {
      let participation: LeaderIdParticipation;
      try {
        participation = await this.#client.createParticipation({
          userId: input.context.binding.leaderIdUserId,
          eventId: input.event.leaderIdEventId,
          accessToken: input.context.tokens.accessToken,
          ...(input.quizAnswerId === null ? {} : { quizAnswerId: input.quizAnswerId }),
        });
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        try {
          await this.#refreshTokens(input.context);
        } catch (refreshError) {
          // A received 401 is a definite rejection, so the durable claim can be finalized safely
          // when token refresh/relink fails; unlike an ambiguous network loss, it need not strand.
          return this.#persistResult(
            {
              binding: input.context.binding,
              event: input.event,
              previous: input.previous,
              status: 'FAILED',
              retryable: true,
              errorCode: safeErrorCode(refreshError),
            },
            claim,
          );
        }
        participation = await this.#client.createParticipation({
          userId: input.context.binding.leaderIdUserId,
          eventId: input.event.leaderIdEventId,
          accessToken: input.context.tokens.accessToken,
          ...(input.quizAnswerId === null ? {} : { quizAnswerId: input.quizAnswerId }),
        });
      }
      if (participation.eventId !== input.event.leaderIdEventId) {
        throw new LeaderIdApiError({
          message: 'Leader-ID вернул участие в другом мероприятии',
          status: 200,
          retryable: false,
          externalCode: 'EVENT_MISMATCH',
        });
      }
      return this.#persistParticipationResult(
        {
          binding: input.context.binding,
          event: input.event,
          previous: input.previous,
          participation,
          existing: false,
        },
        claim,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      // The official contract has no idempotency key or duplicate semantics. A failed POST is
      // never repeated automatically; first reconcile through the read endpoint.
      try {
        const reconciled = (await this.#loadParticipationMap(input.context)).get(
          input.event.leaderIdEventId,
        );
        if (reconciled) {
          return this.#persistParticipationResult(
            {
              binding: input.context.binding,
              event: input.event,
              previous: input.previous,
              participation: reconciled,
              existing: true,
            },
            claim,
          );
        }
      } catch (reconciliationError) {
        if (reconciliationError instanceof AppError) {
          // Keep an UNKNOWN fence only when the POST may have reached Leader-ID. A definite
          // HTTP rejection is safe to finalize even if the follow-up GET requires reauth;
          // otherwise that user would remain permanently stuck behind a false UNKNOWN claim.
          if (isUncertainPostFailure(error)) throw reconciliationError;
          const status = normalizedFailureStatus(error);
          return this.#persistResult(
            {
              binding: input.context.binding,
              event: input.event,
              previous: input.previous,
              status,
              retryable:
                isUnauthorized(error) ||
                (status === 'FAILED' && isLeaderIdApiError(error) ? error.retryable : false),
              errorCode: isUnauthorized(error) ? 'LEADER_ID_REAUTH_REQUIRED' : safeErrorCode(error),
            },
            claim,
          );
        }
        // Preserve the original POST failure, while making a future user retry eligible when
        // either the POST or reconciliation failed transiently.
        const retryable =
          (isLeaderIdApiError(error) && error.retryable) ||
          (isLeaderIdApiError(reconciliationError) && reconciliationError.retryable);
        return this.#persistResult(
          {
            binding: input.context.binding,
            event: input.event,
            previous: input.previous,
            status: 'FAILED',
            retryable,
            errorCode: isUncertainPostFailure(error)
              ? leaderIdPostOutcomeUnknown
              : safeErrorCode(error),
          },
          claim,
        );
      }
      const status = normalizedFailureStatus(error);
      return this.#persistResult(
        {
          binding: input.context.binding,
          event: input.event,
          previous: input.previous,
          status,
          retryable: status === 'FAILED' && isLeaderIdApiError(error) ? error.retryable : false,
          errorCode: isUncertainPostFailure(error)
            ? leaderIdPostOutcomeUnknown
            : safeErrorCode(error),
        },
        claim,
      );
    }
  }

  async #persistParticipationResult(
    input: {
      binding: LeaderIdBinding;
      event: CatalystLeaderIdEvent;
      previous: StoredLeaderIdRegistrationResult | null;
      participation: LeaderIdParticipation;
      existing: boolean;
    },
    claim?: StoredLeaderIdRegistrationResult,
  ): Promise<StoredLeaderIdRegistrationResult> {
    const status = moderationStatus(input.participation, input.existing);
    return this.#persistResult(
      {
        binding: input.binding,
        event: input.event,
        previous: input.previous,
        status,
        retryable: false,
        officialParticipationId: input.participation.id,
        officialModeration: input.participation.moderation,
        ...(status === 'FAILED' ? { errorCode: 'APPLICATION_DECLINED' } : {}),
      },
      claim,
    );
  }

  #buildResult(
    input: {
      binding: LeaderIdBinding;
      event: CatalystLeaderIdEvent;
      previous: StoredLeaderIdRegistrationResult | null;
      status: LeaderIdRegistrationStatus;
      retryable: boolean;
      officialParticipationId?: string;
      officialModeration?: LeaderIdParticipation['moderation'];
      errorCode?: string;
    },
    attemptCount = (input.previous?.attemptCount ?? 0) + 1,
    claimToken?: string,
  ): StoredLeaderIdRegistrationResult {
    return {
      catalystUserId: input.binding.catalystUserId,
      leaderIdUserId: input.binding.leaderIdUserId,
      catalystEventId: input.event.id,
      leaderIdEventId: input.event.leaderIdEventId,
      status: input.status,
      retryable: input.retryable,
      attemptCount,
      updatedAt: this.#now().toISOString(),
      ...(claimToken === undefined ? {} : { claimToken }),
      ...(input.officialParticipationId === undefined
        ? {}
        : { officialParticipationId: input.officialParticipationId }),
      ...(input.officialModeration === undefined
        ? {}
        : { officialModeration: input.officialModeration }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    };
  }

  async #persistResult(
    input: {
      binding: LeaderIdBinding;
      event: CatalystLeaderIdEvent;
      previous: StoredLeaderIdRegistrationResult | null;
      status: LeaderIdRegistrationStatus;
      retryable: boolean;
      officialParticipationId?: string;
      officialModeration?: LeaderIdParticipation['moderation'];
      errorCode?: string;
    },
    claim?: StoredLeaderIdRegistrationResult,
  ): Promise<StoredLeaderIdRegistrationResult> {
    const inheritedClaim =
      claim ??
      (input.previous?.claimToken && hasCurrentSnapshot(input.previous, input.binding, input.event)
        ? input.previous
        : undefined);
    const result = this.#buildResult(
      input,
      inheritedClaim?.attemptCount,
      inheritedClaim?.claimToken,
    );
    const authoritative = inheritedClaim
      ? await this.#registrations.completeClaim(result)
      : await this.#registrations.saveResult(result, input.previous);
    if (!hasCurrentSnapshot(authoritative, input.binding, input.event)) {
      throw new AppError(
        'LEADER_ID_STATE_CHANGED',
        'Подключение Leader-ID или список мероприятий изменился. Повторите действие.',
        409,
      );
    }
    return authoritative;
  }

  async #loadParticipationMap(
    context: MutableUserTokenContext,
  ): Promise<Map<number, LeaderIdParticipation>> {
    let participations: LeaderIdParticipation[];
    try {
      participations = await this.#retryRead(() =>
        this.#client.listParticipations(context.binding.leaderIdUserId, context.tokens.accessToken),
      );
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.#refreshTokens(context);
      participations = await this.#retryRead(() =>
        this.#client.listParticipations(context.binding.leaderIdUserId, context.tokens.accessToken),
      );
    }
    return new Map(participations.map((participation) => [participation.eventId, participation]));
  }

  async #refreshIfExpiring(context: MutableUserTokenContext): Promise<void> {
    const expiresAt = context.tokens.expiresAt ?? context.binding.tokenExpiresAt;
    if (expiresAt && Date.parse(expiresAt) <= this.#now().getTime() + 60_000) {
      await this.#refreshTokens(context);
    }
  }

  async #refreshTokens(context: MutableUserTokenContext): Promise<void> {
    const refreshToken = context.tokens.refreshToken;
    if (!refreshToken) {
      throw new AppError('LEADER_ID_REAUTH_REQUIRED', 'Подключите Leader-ID заново', 409);
    }
    let refreshed: LeaderIdTokenSet;
    try {
      // Refresh token rotation is not documented, so a failed refresh is not auto-retried.
      refreshed = await this.#client.refreshAccessToken({
        clientId: this.#oauth.clientId,
        clientSecret: this.#oauth.clientSecret,
        refreshToken,
      });
    } catch (error) {
      if (isLeaderIdApiError(error) && error.retryable) {
        throw new AppError(
          'LEADER_ID_REFRESH_UNAVAILABLE',
          'Leader-ID временно недоступен. Повторите попытку.',
          503,
        );
      }
      throw new AppError('LEADER_ID_REAUTH_REQUIRED', 'Подключите Leader-ID заново', 409);
    }
    context.tokens = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? refreshToken,
      leaderIdUserId: context.binding.leaderIdUserId,
      ...((refreshed.userValidated ?? context.tokens.userValidated) === undefined
        ? {}
        : { userValidated: refreshed.userValidated ?? context.tokens.userValidated }),
    };
    const encryptedTokens = this.#tokenCipher.encrypt(
      context.tokens,
      context.binding.catalystUserId,
    );
    await this.#bindings.updateEncryptedTokens({
      catalystUserId: context.binding.catalystUserId,
      expectedLeaderIdUserId: context.binding.leaderIdUserId,
      expectedLinkedAt: context.binding.linkedAt,
      encryptedTokens,
      ...(context.tokens.expiresAt === undefined
        ? {}
        : { tokenExpiresAt: context.tokens.expiresAt }),
    });
    context.binding = {
      ...context.binding,
      encryptedTokens,
      ...(context.tokens.expiresAt === undefined
        ? {}
        : { tokenExpiresAt: context.tokens.expiresAt }),
    };
  }

  async #retryRead<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maximumReadAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (
          !isLeaderIdApiError(error) ||
          !error.retryable ||
          attempt === this.#maximumReadAttempts
        ) {
          throw error;
        }
        const delay = error.retryAfterMs ?? Math.min(100 * 2 ** (attempt - 1), 1_000);
        await this.#sleep(delay);
      }
    }
    throw asError(lastError);
  }

  async #resolveReward(
    catalystUserId: string,
    events: CatalystLeaderIdEvent[],
    results: LeaderIdEventResult[],
    policy: LeaderIdRewardPolicy | null,
  ): Promise<LeaderIdRewardGrant | null> {
    const reason = policy?.reason ?? leaderIdSubscriptionRewardReason;
    const existing = await this.#rewards.findGrant(catalystUserId, reason);
    if (existing) return { ...existing, awarded: false, replayed: true };
    if (!policy?.active || policy.points <= 0n) return null;
    const qualifying = new Set(policy.qualifyingStatuses);
    const required = events.filter((event) => event.requiredForSubscription);
    const resultByEvent = new Map(results.map((result) => [result.catalystEventId, result]));
    const qualifyingEventIds = events
      .filter((event) => qualifying.has(resultByEvent.get(event.id)?.status ?? 'FAILED'))
      .map((event) => event.id);
    const eligible = policy.requireAllRequiredEvents
      ? required.length > 0 && required.every((event) => qualifyingEventIds.includes(event.id))
      : qualifyingEventIds.length > 0;
    if (!eligible) return null;
    return this.#rewards.awardOnce({
      catalystUserId,
      reason: policy.reason,
      points: policy.points,
      idempotencyKey: rewardIdempotencyKey(catalystUserId, policy.reason),
      qualifyingEventIds,
    });
  }

  #summarize(
    binding: LeaderIdBinding,
    events: CatalystLeaderIdEvent[],
    results: LeaderIdEventResult[],
    policy: LeaderIdRewardPolicy | null,
    reward: LeaderIdRewardGrant | null,
  ): LeaderIdSubscriptionSummary {
    const confirmedEvents = results.filter((result) =>
      CONFIRMED_STATUSES.has(result.status),
    ).length;
    const submittedEvents = results.filter((result) =>
      DEFAULT_SUBMITTED_STATUSES.has(result.status),
    ).length;
    const byEvent = new Map(results.map((result) => [result.catalystEventId, result.status]));
    const subscriptionComplete = events.every((event) =>
      DEFAULT_SUBMITTED_STATUSES.has(byEvent.get(event.id) ?? 'FAILED'),
    );
    const failedEvents = results.length - submittedEvents;
    return {
      linked: true,
      leaderIdUserId: binding.leaderIdUserId,
      totalEvents: events.length,
      confirmedEvents,
      submittedEvents,
      failedEvents,
      subscriptionComplete,
      partial: submittedEvents > 0 && !subscriptionComplete,
      results,
      reward: {
        configured: policy?.active === true,
        points: (reward?.points ?? (policy?.active === true ? policy.points : 0n)).toString(),
        awarded: reward?.awarded === true || reward?.replayed === true,
        replayed: reward?.replayed === true,
      },
    };
  }
}
