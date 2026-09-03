import { z } from 'zod';

export const leaderIdRegistrationStatuses = [
  'REGISTERED',
  'ALREADY_REGISTERED',
  'PENDING_APPROVAL',
  'QUESTIONNAIRE_REQUIRED',
  'REGISTRATION_CLOSED',
  'EVENT_NOT_AVAILABLE',
  'FAILED',
] as const;

export type LeaderIdRegistrationStatus = (typeof leaderIdRegistrationStatuses)[number];
export const leaderIdPostOutcomeUnknown = 'LEADER_ID_POST_OUTCOME_UNKNOWN' as const;
export const leaderIdSubscriptionRewardReason = 'LEADER_ID_CATALYST_SUBSCRIPTION' as const;

const leaderIdStringSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,15}$/u, 'Leader-ID должен быть положительным числом');

export function parseLeaderIdUserId(value: unknown): number {
  const normalized =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : leaderIdStringSchema.parse(value);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: [],
        message: 'Leader-ID выходит за допустимый диапазон',
      },
    ]);
  }
  return parsed;
}

export interface LeaderIdTokenSet {
  accessToken: string;
  refreshToken?: string;
  leaderIdUserId?: number;
  userValidated?: boolean;
  expiresAt?: string;
}

export interface LeaderIdUser {
  id: number;
  status?: number;
}

export type LeaderIdModeration = 'wait' | 'approved' | 'declined';

export interface LeaderIdParticipation {
  id: string;
  eventId: number;
  moderation: LeaderIdModeration;
  completed: boolean;
  createdAt?: string;
  completedAt?: string;
}

export interface CreateLeaderIdParticipationInput {
  userId: number;
  eventId: number;
  accessToken: string;
  disableNotifications?: boolean;
  quizAnswerId?: string;
}

export interface LeaderIdApiClient {
  createAuthorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    scope?: string;
  }): string;
  exchangeAuthorizationCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
  }): Promise<LeaderIdTokenSet>;
  exchangeClientCredentials(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<LeaderIdTokenSet>;
  refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<LeaderIdTokenSet>;
  getUser(userId: number, accessToken: string): Promise<LeaderIdUser>;
  listParticipations(userId: number, accessToken: string): Promise<LeaderIdParticipation[]>;
  createParticipation(input: CreateLeaderIdParticipationInput): Promise<LeaderIdParticipation>;
}

export interface LeaderIdOAuthStateRecord {
  catalystUserId: string;
  expectedLeaderIdUserId: number;
  createdAt: string;
  expiresAt: string;
}

/** Implementations must make `take` atomic so an OAuth callback cannot be replayed. */
export interface LeaderIdOAuthStateRepository {
  put(digest: string, value: LeaderIdOAuthStateRecord, ttlSeconds: number): Promise<void>;
  take(digest: string): Promise<LeaderIdOAuthStateRecord | null>;
}

export interface LeaderIdOAuthStateManager {
  issue(input: { catalystUserId: string; expectedLeaderIdUserId: number }): Promise<string>;
  consume(state: string): Promise<LeaderIdOAuthStateRecord>;
}

export interface LeaderIdTokenCipher {
  encrypt(tokens: LeaderIdTokenSet, catalystUserId: string): string;
  decrypt(envelope: string, catalystUserId: string): LeaderIdTokenSet;
}

export interface LeaderIdBinding {
  catalystUserId: string;
  leaderIdUserId: number;
  encryptedTokens: string;
  linkedAt: string;
  tokenExpiresAt?: string;
}

export interface LeaderIdBindingRepository {
  findByCatalystUserId(catalystUserId: string): Promise<LeaderIdBinding | null>;
  findByLeaderIdUserId(leaderIdUserId: number): Promise<LeaderIdBinding | null>;
  /** Returns false when a newer binding or unresolved registration safely fences the callback. */
  upsertVerifiedBinding(binding: LeaderIdBinding): Promise<boolean>;
  updateEncryptedTokens(input: {
    catalystUserId: string;
    expectedLeaderIdUserId: number;
    expectedLinkedAt: string;
    encryptedTokens: string;
    tokenExpiresAt?: string;
  }): Promise<void>;
}

export interface CatalystLeaderIdEvent {
  id: string;
  leaderIdEventId: number;
  title: string;
  active: boolean;
  requiredForSubscription: boolean;
  registrationOpen: boolean;
  sortOrder: number;
  requiresQuestionnaire: boolean;
}

export interface CatalystLeaderIdEventRegistry {
  listActiveEvents(): Promise<CatalystLeaderIdEvent[]>;
}

export interface LeaderIdQuestionnaireAnswerProvider {
  findQuizAnswerId(input: {
    catalystUserId: string;
    leaderIdUserId: number;
    event: CatalystLeaderIdEvent;
  }): Promise<string | null>;
}

export interface StoredLeaderIdRegistrationResult {
  catalystUserId: string;
  /** Snapshot fences terminal rows to the verified external identity that produced them. */
  leaderIdUserId: number;
  catalystEventId: string;
  leaderIdEventId: number;
  status: LeaderIdRegistrationStatus;
  retryable: boolean;
  officialParticipationId?: string;
  officialModeration?: LeaderIdModeration;
  errorCode?: string;
  attemptCount: number;
  /** Opaque fencing token present only while an external POST generation is unresolved. */
  claimToken?: string;
  updatedAt: string;
}

/**
 * Production implementations need both a per-Catalyst-user lock and a unique key on
 * `(catalystUserId, catalystEventId)`. The lock must cover the preflight/create/reconcile flow.
 */
export interface LeaderIdRegistrationRepository {
  withUserLock<T>(catalystUserId: string, operation: () => Promise<T>): Promise<T>;
  findResult(
    catalystUserId: string,
    catalystEventId: string,
  ): Promise<StoredLeaderIdRegistrationResult | null>;
  /** Compare-and-set save; returns the authoritative row when another worker won the race. */
  saveResult(
    result: StoredLeaderIdRegistrationResult,
    expectedPrevious: StoredLeaderIdRegistrationResult | null,
  ): Promise<StoredLeaderIdRegistrationResult>;
  /**
   * Atomically records a durable pre-POST claim. Only one contender for the expected generation
   * may return true. An unresolved POST_OUTCOME_UNKNOWN claim must never be reclaimed.
   */
  claimAttempt(
    result: StoredLeaderIdRegistrationResult,
    expectedAttemptCount: number,
  ): Promise<boolean>;
  /** Completes only the still-current claimed generation and returns the authoritative row. */
  completeClaim(
    result: StoredLeaderIdRegistrationResult,
  ): Promise<StoredLeaderIdRegistrationResult>;
  listResults(catalystUserId: string): Promise<StoredLeaderIdRegistrationResult[]>;
}

export interface LeaderIdRewardPolicy {
  active: boolean;
  reason: string;
  points: bigint;
  requireAllRequiredEvents: boolean;
  qualifyingStatuses: readonly LeaderIdRegistrationStatus[];
}

export interface LeaderIdRewardPolicyProvider {
  getPolicy(): Promise<LeaderIdRewardPolicy | null>;
}

export interface LeaderIdRewardGrant {
  awarded: boolean;
  replayed: boolean;
  points: bigint;
  transactionId?: string;
}

/**
 * This operation must atomically enforce uniqueness by Catalyst user + reward reason and post the
 * wallet ledger transaction. Rechecking eligibility in the same DB transaction is recommended.
 */
export interface LeaderIdRewardIssuer {
  awardOnce(input: {
    catalystUserId: string;
    reason: string;
    points: bigint;
    idempotencyKey: string;
    qualifyingEventIds: readonly string[];
  }): Promise<LeaderIdRewardGrant>;
  findGrant(catalystUserId: string, reason: string): Promise<LeaderIdRewardGrant | null>;
}

export interface LeaderIdEventResult {
  catalystEventId: string;
  leaderIdEventId: number;
  title: string;
  requiredForSubscription: boolean;
  status: LeaderIdRegistrationStatus;
  retryable: boolean;
  officialParticipationId?: string;
  officialModeration?: LeaderIdModeration;
  errorCode?: string;
}

export interface LeaderIdSubscriptionSummary {
  linked: true;
  leaderIdUserId: number;
  totalEvents: number;
  confirmedEvents: number;
  submittedEvents: number;
  failedEvents: number;
  subscriptionComplete: boolean;
  partial: boolean;
  results: LeaderIdEventResult[];
  reward: {
    configured: boolean;
    points: string;
    awarded: boolean;
    replayed: boolean;
  };
}

export interface LeaderIdStatusSnapshot {
  linked: boolean;
  leaderIdUserId?: number;
  totalEvents: number;
  confirmedEvents: number;
  submittedEvents: number;
  failedEvents: number;
  subscriptionComplete: boolean;
  partial: boolean;
  results: LeaderIdEventResult[];
  reward: {
    configured: boolean;
    points: string;
    awarded: boolean;
  };
}
