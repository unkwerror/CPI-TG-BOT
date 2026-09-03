import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { z } from 'zod';
import type { Database } from '@cpi/db';
import {
  events,
  leaderIdBindings,
  leaderIdEventRegistrations,
  leaderIdRewardGrants,
  leaderIdRewardReason,
  outboxEvents,
  pointPrograms,
  walletAccounts,
  walletSystemKeys,
} from '@cpi/db';
import { AppError, asError } from '@cpi/shared';
import {
  LEADER_ID_APPS_PRODUCTION_BASE_URL,
  LEADER_ID_APPS_STAGING_BASE_URL,
  OfficialLeaderIdClient,
} from './leader-id-client';
import type {
  CatalystLeaderIdEvent,
  CatalystLeaderIdEventRegistry,
  LeaderIdBinding,
  LeaderIdBindingRepository,
  LeaderIdOAuthStateRecord,
  LeaderIdOAuthStateRepository,
  LeaderIdRegistrationRepository,
  LeaderIdRewardGrant,
  LeaderIdRewardIssuer,
  LeaderIdRewardPolicy,
  LeaderIdRewardPolicyProvider,
  StoredLeaderIdRegistrationResult,
} from './leader-id-contract';
import { leaderIdPostOutcomeUnknown, leaderIdSubscriptionRewardReason } from './leader-id-contract';
import {
  AesGcmLeaderIdTokenCipher,
  SecureLeaderIdOAuthStateManager,
  type LeaderIdTokenKeyRing,
} from './leader-id-crypto';
import { LeaderIdService } from './leader-id-service';
import { createLeaderIdRoutes } from './routes/leader-id';
import {
  ensureUserWalletAccount,
  loadActiveWalletContext,
  postLedgerTransaction,
  validateProgramAmount,
  walletProgramLockKey,
  type ActiveWalletContext,
  type WalletTransaction,
} from './wallet-service';
import { walletRequestHash } from './wallet-domain';

const OAUTH_STATE_KEY_PREFIX = 'leader-id:oauth-state:';
const USER_LEASE_KEY_PREFIX = 'leader-id:subscription-lock:';
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_LEASE_RENEW_MS = 20_000;
const DEFAULT_LEASE_WAIT_MS = 5_000;

const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const oauthStateRecordSchema = z
  .object({
    catalystUserId: z.string().uuid(),
    expectedLeaderIdUserId: z.number().int().positive().safe(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const redisPrefixSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/u);
const stateDigestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const catalystUserIdSchema = z.string().uuid();

type LeaderIdTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function transactionDatabase(transaction: LeaderIdTransaction): Database {
  return transaction as unknown as Database;
}

function namespacedKey(prefix: string, suffix: string): string {
  return `${prefix}:${suffix}`;
}

function bindingLockKey(catalystUserId: string): string {
  return `leader-id-binding:${catalystUserId}`;
}

function validDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

function storedRegistration(
  row: typeof leaderIdEventRegistrations.$inferSelect,
): StoredLeaderIdRegistrationResult {
  return {
    catalystUserId: row.userId,
    leaderIdUserId: row.leaderIdUserId,
    catalystEventId: row.eventId,
    leaderIdEventId: row.leaderIdEventId,
    status: row.status,
    retryable: row.retryable,
    attemptCount: row.attemptCount,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.officialParticipationId === null
      ? {}
      : { officialParticipationId: row.officialParticipationId }),
    ...(row.officialModeration === null
      ? {}
      : { officialModeration: row.officialModeration as 'wait' | 'approved' | 'declined' }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    ...(row.attemptClaimToken === null ? {} : { claimToken: row.attemptClaimToken }),
  };
}

function storedBinding(row: typeof leaderIdBindings.$inferSelect): LeaderIdBinding {
  return {
    catalystUserId: row.userId,
    leaderIdUserId: row.leaderIdUserId,
    encryptedTokens: row.encryptedTokens,
    linkedAt: row.linkedAt.toISOString(),
    ...(row.tokenExpiresAt === null ? {} : { tokenExpiresAt: row.tokenExpiresAt.toISOString() }),
  };
}

function asIntegerResult(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export interface LeaderIdRedisCommands {
  getdel(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX' | 'PX',
    duration: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  eval(
    script: string,
    numberOfKeys: number,
    key: string,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
}

export class RedisLeaderIdOAuthStateRepository implements LeaderIdOAuthStateRepository {
  readonly #redis: LeaderIdRedisCommands;
  readonly #prefix: string;

  constructor(redis: LeaderIdRedisCommands, redisPrefix: string) {
    this.#redis = redis;
    this.#prefix = namespacedKey(redisPrefixSchema.parse(redisPrefix), OAUTH_STATE_KEY_PREFIX);
  }

  async put(digest: string, value: LeaderIdOAuthStateRecord, ttlSeconds: number): Promise<void> {
    stateDigestSchema.parse(digest);
    const record = oauthStateRecordSchema.parse(value);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 1_800) {
      throw new Error('Leader-ID OAuth state TTL is invalid');
    }
    const result = await this.#redis.set(
      `${this.#prefix}${digest}`,
      JSON.stringify(record),
      'EX',
      ttlSeconds,
      'NX',
    );
    if (result !== 'OK') throw new Error('Leader-ID OAuth state digest collision');
  }

  async take(digest: string): Promise<LeaderIdOAuthStateRecord | null> {
    stateDigestSchema.parse(digest);
    const serialized = await this.#redis.getdel(`${this.#prefix}${digest}`);
    if (serialized === null) return null;
    if (serialized.length > 4_096) throw new Error('Leader-ID OAuth state record is too large');
    return oauthStateRecordSchema.parse(JSON.parse(serialized));
  }
}

export interface RedisLeaderIdUserLeaseOptions {
  redis: LeaderIdRedisCommands;
  redisPrefix: string;
  leaseDurationMs?: number;
  renewEveryMs?: number;
  acquisitionWaitMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** A token-owned, renewable Redis lease suitable for multiple API instances. */
export class RedisLeaderIdUserLease {
  readonly #redis: LeaderIdRedisCommands;
  readonly #prefix: string;
  readonly #leaseDurationMs: number;
  readonly #renewEveryMs: number;
  readonly #acquisitionWaitMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: RedisLeaderIdUserLeaseOptions) {
    this.#redis = options.redis;
    this.#prefix = namespacedKey(
      redisPrefixSchema.parse(options.redisPrefix),
      USER_LEASE_KEY_PREFIX,
    );
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#renewEveryMs = options.renewEveryMs ?? DEFAULT_LEASE_RENEW_MS;
    this.#acquisitionWaitMs = options.acquisitionWaitMs ?? DEFAULT_LEASE_WAIT_MS;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleep;
    if (
      !Number.isInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 1_000 ||
      this.#leaseDurationMs > 300_000
    ) {
      throw new Error('Leader-ID lease duration must be between 1000 and 300000 ms');
    }
    if (
      !Number.isInteger(this.#renewEveryMs) ||
      this.#renewEveryMs < 100 ||
      this.#renewEveryMs >= this.#leaseDurationMs / 2
    ) {
      throw new Error('Leader-ID lease renewal interval is invalid');
    }
    if (
      !Number.isInteger(this.#acquisitionWaitMs) ||
      this.#acquisitionWaitMs < 0 ||
      this.#acquisitionWaitMs > 30_000
    ) {
      throw new Error('Leader-ID lease acquisition wait is invalid');
    }
  }

  async withLease<T>(catalystUserId: string, operation: () => Promise<T>): Promise<T> {
    catalystUserIdSchema.parse(catalystUserId);
    const key = `${this.#prefix}${catalystUserId}`;
    const ownershipToken = randomBytes(32).toString('base64url');
    const deadline = this.#now() + this.#acquisitionWaitMs;
    while (true) {
      let acquired: 'OK' | null;
      try {
        acquired = await this.#redis.set(key, ownershipToken, 'PX', this.#leaseDurationMs, 'NX');
      } catch {
        throw new AppError(
          'LEADER_ID_LOCK_UNAVAILABLE',
          'Регистрация временно недоступна. Повторите попытку.',
          503,
        );
      }
      if (acquired === 'OK') break;
      if (this.#now() >= deadline) {
        throw new AppError(
          'LEADER_ID_SUBSCRIPTION_BUSY',
          'Регистрация уже выполняется. Повторите попытку чуть позже.',
          409,
        );
      }
      await this.#sleep(Math.min(100, Math.max(deadline - this.#now(), 1)));
    }

    const renewalController = new AbortController();
    const renewal = this.#renewUntilStopped(key, ownershipToken, renewalController.signal);
    let result: T | undefined;
    let operationError: Error | undefined;
    try {
      result = await operation();
    } catch (error) {
      operationError = asError(error);
    } finally {
      renewalController.abort();
    }
    const leaseLost = await renewal;
    try {
      await this.#redis.eval(RELEASE_LEASE_SCRIPT, 1, key, ownershipToken);
    } catch {
      // The lease has a bounded TTL. A release outage must not turn a completed idempotent
      // operation into a client-visible failure that encourages another registration attempt.
    }
    if (operationError !== undefined) throw operationError;
    if (leaseLost) {
      throw new AppError(
        'LEADER_ID_LOCK_LOST',
        'Не удалось подтвердить завершение регистрации. Обновите статус.',
        409,
      );
    }
    return result as T;
  }

  async #renewUntilStopped(
    key: string,
    ownershipToken: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    while (await abortableDelay(this.#renewEveryMs, signal)) {
      try {
        const renewed = await this.#redis.eval(
          RENEW_LEASE_SCRIPT,
          1,
          key,
          ownershipToken,
          this.#leaseDurationMs,
        );
        if (asIntegerResult(renewed) !== 1) return true;
      } catch {
        return true;
      }
    }
    return false;
  }
}

export class DrizzleLeaderIdBindingRepository implements LeaderIdBindingRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listCatalystUserIds(): Promise<string[]> {
    const rows = await this.#database
      .select({ userId: leaderIdBindings.userId })
      .from(leaderIdBindings)
      .orderBy(asc(leaderIdBindings.linkedAt), asc(leaderIdBindings.userId));
    return rows.map((row) => row.userId);
  }

  async findByCatalystUserId(catalystUserId: string): Promise<LeaderIdBinding | null> {
    const [row] = await this.#database
      .select()
      .from(leaderIdBindings)
      .where(eq(leaderIdBindings.userId, catalystUserId))
      .limit(1);
    return row ? storedBinding(row) : null;
  }

  async findByLeaderIdUserId(leaderIdUserId: number): Promise<LeaderIdBinding | null> {
    const [row] = await this.#database
      .select()
      .from(leaderIdBindings)
      .where(eq(leaderIdBindings.leaderIdUserId, leaderIdUserId))
      .limit(1);
    return row ? storedBinding(row) : null;
  }

  async upsertVerifiedBinding(binding: LeaderIdBinding): Promise<boolean> {
    const tokenExpiresAt = binding.tokenExpiresAt
      ? validDate(binding.tokenExpiresAt, 'Leader-ID token expiry')
      : null;
    const linkedAt = validDate(binding.linkedAt, 'Leader-ID linked timestamp');
    return this.#database.transaction(async (transaction) => {
      const database = transactionDatabase(transaction);
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${bindingLockKey(binding.catalystUserId)}, 0))`,
      );
      const rows = await database
        .insert(leaderIdBindings)
        .values({
          userId: binding.catalystUserId,
          leaderIdUserId: binding.leaderIdUserId,
          encryptedTokens: binding.encryptedTokens,
          tokenExpiresAt,
          linkedAt,
        })
        .onConflictDoUpdate({
          target: leaderIdBindings.userId,
          set: {
            leaderIdUserId: binding.leaderIdUserId,
            encryptedTokens: binding.encryptedTokens,
            tokenExpiresAt,
            linkedAt,
            updatedAt: new Date(),
          },
          setWhere: sql`${leaderIdBindings.linkedAt} < ${linkedAt}
            AND (
              ${leaderIdBindings.leaderIdUserId} = ${binding.leaderIdUserId}
              OR NOT EXISTS (
                SELECT 1 FROM ${leaderIdEventRegistrations}
                WHERE ${leaderIdEventRegistrations.userId} = ${binding.catalystUserId}
                  AND ${leaderIdEventRegistrations.attemptClaimToken} IS NOT NULL
              )
            )`,
        })
        .returning({ userId: leaderIdBindings.userId });
      return rows.length === 1;
    });
  }

  async updateEncryptedTokens(input: {
    catalystUserId: string;
    expectedLeaderIdUserId: number;
    expectedLinkedAt: string;
    encryptedTokens: string;
    tokenExpiresAt?: string;
  }): Promise<void> {
    const expectedLinkedAt = validDate(input.expectedLinkedAt, 'Leader-ID binding generation');
    const rows = await this.#database.transaction(async (transaction) => {
      const database = transactionDatabase(transaction);
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${bindingLockKey(input.catalystUserId)}, 0))`,
      );
      return database
        .update(leaderIdBindings)
        .set({
          encryptedTokens: input.encryptedTokens,
          tokenExpiresAt: input.tokenExpiresAt
            ? validDate(input.tokenExpiresAt, 'Leader-ID token expiry')
            : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leaderIdBindings.userId, input.catalystUserId),
            eq(leaderIdBindings.leaderIdUserId, input.expectedLeaderIdUserId),
            eq(leaderIdBindings.linkedAt, expectedLinkedAt),
          ),
        )
        .returning({ userId: leaderIdBindings.userId });
    });
    if (rows.length !== 1) {
      throw new AppError(
        'LEADER_ID_BINDING_CHANGED',
        'Подключение Leader-ID изменилось. Повторите действие.',
        409,
      );
    }
  }
}

export class DrizzleCatalystLeaderIdEventRegistry implements CatalystLeaderIdEventRegistry {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listActiveEvents(): Promise<CatalystLeaderIdEvent[]> {
    const rows = await this.#database
      .select({
        id: events.id,
        leaderIdEventId: events.leaderIdEventId,
        title: events.title,
        requiredForSubscription: events.leaderIdRequiredForSubscription,
        registrationOpen: events.leaderIdRegistrationOpen,
        sortOrder: events.leaderIdSortOrder,
        requiresQuestionnaire: events.leaderIdRequiresQuestionnaire,
      })
      .from(events)
      .where(
        and(
          eq(events.leaderIdRegistrationActive, true),
          isNotNull(events.leaderIdEventId),
          isNull(events.deletedAt),
        ),
      )
      .orderBy(asc(events.leaderIdSortOrder), asc(events.leaderIdEventId));
    return rows.map((row) => {
      if (row.leaderIdEventId === null)
        throw new Error('Active Leader-ID event has no external ID');
      return {
        id: row.id,
        leaderIdEventId: row.leaderIdEventId,
        title: row.title,
        active: true,
        requiredForSubscription: row.requiredForSubscription,
        registrationOpen: row.registrationOpen,
        sortOrder: row.sortOrder,
        requiresQuestionnaire: row.requiresQuestionnaire,
      };
    });
  }
}

export class DrizzleLeaderIdRegistrationRepository implements LeaderIdRegistrationRepository {
  readonly #database: Database;
  readonly #lease: RedisLeaderIdUserLease;

  constructor(database: Database, lease: RedisLeaderIdUserLease) {
    this.#database = database;
    this.#lease = lease;
  }

  withUserLock<T>(catalystUserId: string, operation: () => Promise<T>): Promise<T> {
    return this.#lease.withLease(catalystUserId, operation);
  }

  async findResult(
    catalystUserId: string,
    catalystEventId: string,
  ): Promise<StoredLeaderIdRegistrationResult | null> {
    const [row] = await this.#database
      .select()
      .from(leaderIdEventRegistrations)
      .where(
        and(
          eq(leaderIdEventRegistrations.userId, catalystUserId),
          eq(leaderIdEventRegistrations.eventId, catalystEventId),
        ),
      )
      .limit(1);
    return row ? storedRegistration(row) : null;
  }

  async saveResult(
    result: StoredLeaderIdRegistrationResult,
    expectedPrevious: StoredLeaderIdRegistrationResult | null,
  ): Promise<StoredLeaderIdRegistrationResult> {
    const sameSnapshotAsPrevious =
      expectedPrevious !== null &&
      result.leaderIdUserId === expectedPrevious.leaderIdUserId &&
      result.leaderIdEventId === expectedPrevious.leaderIdEventId;
    if (
      result.claimToken !== undefined ||
      (expectedPrevious?.claimToken !== undefined && sameSnapshotAsPrevious)
    ) {
      throw new Error('Leader-ID same-snapshot claimed result must use completeClaim');
    }
    if (
      expectedPrevious !== null &&
      (result.attemptCount !== expectedPrevious.attemptCount + 1 ||
        result.catalystUserId !== expectedPrevious.catalystUserId ||
        result.catalystEventId !== expectedPrevious.catalystEventId)
    ) {
      throw new Error('Leader-ID result CAS generation is invalid');
    }
    const updatedAt = validDate(result.updatedAt, 'Leader-ID registration timestamp');
    const values = {
      userId: result.catalystUserId,
      leaderIdUserId: result.leaderIdUserId,
      eventId: result.catalystEventId,
      leaderIdEventId: result.leaderIdEventId,
      status: result.status,
      retryable: result.retryable,
      officialParticipationId: result.officialParticipationId ?? null,
      officialModeration: result.officialModeration ?? null,
      errorCode: result.errorCode ?? null,
      attemptCount: result.attemptCount,
      attemptClaimToken: null,
      lastAttemptAt: updatedAt,
      updatedAt,
    };
    const rows =
      expectedPrevious === null
        ? await this.#database
            .insert(leaderIdEventRegistrations)
            .values(values)
            .onConflictDoNothing({
              target: [leaderIdEventRegistrations.userId, leaderIdEventRegistrations.eventId],
            })
            .returning()
        : await this.#database
            .update(leaderIdEventRegistrations)
            .set({
              leaderIdUserId: result.leaderIdUserId,
              leaderIdEventId: result.leaderIdEventId,
              status: result.status,
              retryable: result.retryable,
              officialParticipationId: result.officialParticipationId ?? null,
              officialModeration: result.officialModeration ?? null,
              errorCode: result.errorCode ?? null,
              attemptCount: result.attemptCount,
              attemptClaimToken: null,
              lastAttemptAt: updatedAt,
              updatedAt,
            })
            .where(
              and(
                eq(leaderIdEventRegistrations.userId, result.catalystUserId),
                eq(leaderIdEventRegistrations.eventId, result.catalystEventId),
                eq(leaderIdEventRegistrations.leaderIdUserId, expectedPrevious.leaderIdUserId),
                eq(leaderIdEventRegistrations.leaderIdEventId, expectedPrevious.leaderIdEventId),
                eq(leaderIdEventRegistrations.attemptCount, expectedPrevious.attemptCount),
                expectedPrevious.claimToken === undefined
                  ? isNull(leaderIdEventRegistrations.attemptClaimToken)
                  : eq(leaderIdEventRegistrations.attemptClaimToken, expectedPrevious.claimToken),
              ),
            )
            .returning();
    const completed = rows[0];
    if (completed) return storedRegistration(completed);
    const authoritative = await this.findResult(result.catalystUserId, result.catalystEventId);
    if (!authoritative) throw new Error('Leader-ID result CAS row disappeared');
    return authoritative;
  }

  async claimAttempt(
    result: StoredLeaderIdRegistrationResult,
    expectedAttemptCount: number,
  ): Promise<boolean> {
    if (
      result.errorCode !== leaderIdPostOutcomeUnknown ||
      result.status !== 'FAILED' ||
      result.claimToken === undefined ||
      !Number.isInteger(expectedAttemptCount) ||
      expectedAttemptCount < 0 ||
      result.attemptCount !== expectedAttemptCount + 1
    ) {
      throw new Error('Leader-ID durable attempt claim is invalid');
    }
    const updatedAt = validDate(result.updatedAt, 'Leader-ID attempt claim timestamp');
    return this.#database.transaction(async (transaction) => {
      const database = transactionDatabase(transaction);
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${bindingLockKey(result.catalystUserId)}, 0))`,
      );
      const [binding] = await database
        .select({ leaderIdUserId: leaderIdBindings.leaderIdUserId })
        .from(leaderIdBindings)
        .where(eq(leaderIdBindings.userId, result.catalystUserId))
        .limit(1);
      if (!binding || binding.leaderIdUserId !== result.leaderIdUserId) return false;
      const [configuredEvent] = await database
        .select({
          leaderIdEventId: events.leaderIdEventId,
          active: events.leaderIdRegistrationActive,
          deletedAt: events.deletedAt,
        })
        .from(events)
        .where(eq(events.id, result.catalystEventId))
        .for('share')
        .limit(1);
      if (
        !configuredEvent ||
        !configuredEvent.active ||
        configuredEvent.deletedAt !== null ||
        configuredEvent.leaderIdEventId !== result.leaderIdEventId
      ) {
        return false;
      }
      const rows = await database
        .insert(leaderIdEventRegistrations)
        .values({
          userId: result.catalystUserId,
          leaderIdUserId: result.leaderIdUserId,
          eventId: result.catalystEventId,
          leaderIdEventId: result.leaderIdEventId,
          status: result.status,
          retryable: result.retryable,
          officialParticipationId: null,
          officialModeration: null,
          errorCode: result.errorCode,
          attemptCount: result.attemptCount,
          attemptClaimToken: result.claimToken,
          lastAttemptAt: updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [leaderIdEventRegistrations.userId, leaderIdEventRegistrations.eventId],
          set: {
            leaderIdUserId: result.leaderIdUserId,
            leaderIdEventId: result.leaderIdEventId,
            status: result.status,
            retryable: result.retryable,
            officialParticipationId: null,
            officialModeration: null,
            errorCode: result.errorCode,
            attemptCount: result.attemptCount,
            attemptClaimToken: result.claimToken,
            lastAttemptAt: updatedAt,
            updatedAt,
          },
          setWhere: sql`(
          ${leaderIdEventRegistrations.leaderIdUserId} <> ${result.leaderIdUserId}
          OR ${leaderIdEventRegistrations.leaderIdEventId} <> ${result.leaderIdEventId}
          OR (
            ${leaderIdEventRegistrations.attemptCount} = ${expectedAttemptCount}
            AND ${leaderIdEventRegistrations.errorCode}
              IS DISTINCT FROM ${leaderIdPostOutcomeUnknown}
          )
        )`,
        })
        .returning({ id: leaderIdEventRegistrations.id });
      return rows.length === 1;
    });
  }

  async completeClaim(
    result: StoredLeaderIdRegistrationResult,
  ): Promise<StoredLeaderIdRegistrationResult> {
    if (result.claimToken === undefined) {
      throw new Error('Leader-ID attempt completion token is missing');
    }
    const updatedAt = validDate(result.updatedAt, 'Leader-ID attempt completion timestamp');
    const [completed] = await this.#database
      .update(leaderIdEventRegistrations)
      .set({
        status: result.status,
        retryable: result.retryable,
        officialParticipationId: result.officialParticipationId ?? null,
        officialModeration: result.officialModeration ?? null,
        errorCode: result.errorCode ?? null,
        attemptClaimToken: null,
        lastAttemptAt: updatedAt,
        updatedAt,
      })
      .where(
        and(
          eq(leaderIdEventRegistrations.userId, result.catalystUserId),
          eq(leaderIdEventRegistrations.eventId, result.catalystEventId),
          eq(leaderIdEventRegistrations.leaderIdUserId, result.leaderIdUserId),
          eq(leaderIdEventRegistrations.leaderIdEventId, result.leaderIdEventId),
          eq(leaderIdEventRegistrations.attemptCount, result.attemptCount),
          eq(leaderIdEventRegistrations.attemptClaimToken, result.claimToken),
          eq(leaderIdEventRegistrations.errorCode, leaderIdPostOutcomeUnknown),
        ),
      )
      .returning();
    if (completed) return storedRegistration(completed);
    const authoritative = await this.findResult(result.catalystUserId, result.catalystEventId);
    if (!authoritative) throw new Error('Leader-ID attempt claim disappeared');
    return authoritative;
  }

  async listResults(catalystUserId: string): Promise<StoredLeaderIdRegistrationResult[]> {
    const rows = await this.#database
      .select()
      .from(leaderIdEventRegistrations)
      .where(eq(leaderIdEventRegistrations.userId, catalystUserId));
    return rows.map(storedRegistration);
  }
}

export class DrizzleLeaderIdRewardPolicyProvider implements LeaderIdRewardPolicyProvider {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async getPolicy(): Promise<LeaderIdRewardPolicy | null> {
    const [program] = await this.#database
      .select({ amount: pointPrograms.leaderIdSubscriptionReward })
      .from(pointPrograms)
      .where(eq(pointPrograms.isDefault, true))
      .limit(1);
    if (!program) return null;
    return {
      active: program.amount > 0n,
      reason: leaderIdSubscriptionRewardReason,
      points: program.amount,
      requireAllRequiredEvents: true,
      qualifyingStatuses: ['REGISTERED', 'ALREADY_REGISTERED', 'PENDING_APPROVAL'],
    };
  }
}

function rewardGrant(row: typeof leaderIdRewardGrants.$inferSelect): LeaderIdRewardGrant {
  return {
    awarded: true,
    replayed: false,
    points: row.amount,
    transactionId: row.transactionId,
  };
}

async function ensureLeaderIdIssuanceAccount(
  transaction: WalletTransaction,
  context: ActiveWalletContext,
): Promise<typeof walletAccounts.$inferSelect> {
  const database = transactionDatabase(transaction);
  await database
    .insert(walletAccounts)
    .values({
      programId: context.program.id,
      seasonId: context.season.id,
      ownerKind: 'system_issuance',
      systemKey: walletSystemKeys.leaderId,
      title: 'Награды Leader-ID',
      allowNegative: true,
    })
    .onConflictDoNothing();
  const [account] = await database
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.programId, context.program.id),
        eq(walletAccounts.seasonId, context.season.id),
        eq(walletAccounts.systemKey, walletSystemKeys.leaderId),
      ),
    )
    .limit(1);
  if (!account) throw new Error('Leader-ID issuance wallet account was not created');
  return account;
}

function expectedRewardIdempotencyKey(catalystUserId: string): string {
  return `leader-id-subscription:${leaderIdRewardReason}:${catalystUserId}`;
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export class DrizzleLeaderIdRewardIssuer implements LeaderIdRewardIssuer {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async awardOnce(input: {
    catalystUserId: string;
    reason: string;
    points: bigint;
    idempotencyKey: string;
    qualifyingEventIds: readonly string[];
  }): Promise<LeaderIdRewardGrant> {
    catalystUserIdSchema.parse(input.catalystUserId);
    if (
      input.reason !== leaderIdRewardReason ||
      input.idempotencyKey !== expectedRewardIdempotencyKey(input.catalystUserId)
    ) {
      throw new AppError(
        'LEADER_ID_REWARD_REQUEST_INVALID',
        'Параметры награды Leader-ID не прошли проверку',
        409,
      );
    }
    try {
      return await this.#database.transaction(async (transaction) => {
        const database = transactionDatabase(transaction);
        await database.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`leader-id-reward:${input.catalystUserId}:${leaderIdRewardReason}`}, 0))`,
        );
        const [existing] = await database
          .select()
          .from(leaderIdRewardGrants)
          .where(
            and(
              eq(leaderIdRewardGrants.userId, input.catalystUserId),
              eq(leaderIdRewardGrants.reason, leaderIdRewardReason),
            ),
          )
          .limit(1);
        if (existing) return { ...rewardGrant(existing), awarded: false, replayed: true };

        const initialContext = await loadActiveWalletContext(database);
        // Match the global wallet lock order: advisory programme lock first, row lock second.
        // Season reset takes the exclusive form in this same order.
        await database.execute(
          sql`select pg_advisory_xact_lock_shared(hashtextextended(${walletProgramLockKey(initialContext.program.id)}, 0))`,
        );
        // Serialize reward configuration with the admin settings UPDATE. The locked row is the
        // source of truth used for both the configured amount and transaction limits.
        const [lockedProgram] = await database
          .select()
          .from(pointPrograms)
          .where(eq(pointPrograms.id, initialContext.program.id))
          .for('share')
          .limit(1);
        if (!lockedProgram || lockedProgram.activeSeasonId !== initialContext.season.id) {
          return { awarded: false, replayed: false, points: input.points };
        }
        const context: ActiveWalletContext = {
          ...initialContext,
          program: lockedProgram,
        };
        if (
          context.program.leaderIdSubscriptionReward <= 0n ||
          context.program.leaderIdSubscriptionReward !== input.points
        ) {
          return { awarded: false, replayed: false, points: input.points };
        }

        const [binding] = await database
          .select({ leaderIdUserId: leaderIdBindings.leaderIdUserId })
          .from(leaderIdBindings)
          .where(eq(leaderIdBindings.userId, input.catalystUserId))
          .for('share')
          .limit(1);
        if (!binding) {
          return { awarded: false, replayed: false, points: input.points };
        }

        const requiredEvents = await database
          .select({ id: events.id, leaderIdEventId: events.leaderIdEventId })
          .from(events)
          .where(
            and(
              eq(events.leaderIdRegistrationActive, true),
              eq(events.leaderIdRequiredForSubscription, true),
              isNotNull(events.leaderIdEventId),
              isNull(events.deletedAt),
            ),
          )
          .orderBy(asc(events.id))
          .for('share');
        if (requiredEvents.length === 0) {
          return { awarded: false, replayed: false, points: input.points };
        }
        const requiredEventIds = requiredEvents.map((event) => event.id);
        const registrations = await database
          .select({
            eventId: leaderIdEventRegistrations.eventId,
            leaderIdEventId: leaderIdEventRegistrations.leaderIdEventId,
            status: leaderIdEventRegistrations.status,
          })
          .from(leaderIdEventRegistrations)
          .where(
            and(
              eq(leaderIdEventRegistrations.userId, input.catalystUserId),
              eq(leaderIdEventRegistrations.leaderIdUserId, binding.leaderIdUserId),
              inArray(leaderIdEventRegistrations.eventId, requiredEventIds),
            ),
          )
          .for('share');
        const qualifyingStatuses = new Set([
          'REGISTERED',
          'ALREADY_REGISTERED',
          'PENDING_APPROVAL',
        ]);
        const resultByEvent = new Map(
          registrations.map((registration) => [registration.eventId, registration]),
        );
        if (
          !requiredEvents.every((event) => {
            const registration = resultByEvent.get(event.id);
            return (
              registration !== undefined &&
              registration.leaderIdEventId === event.leaderIdEventId &&
              qualifyingStatuses.has(registration.status)
            );
          })
        ) {
          return { awarded: false, replayed: false, points: input.points };
        }

        validateProgramAmount(input.points, context.program);
        const userAccount = await ensureUserWalletAccount(
          transaction,
          context,
          input.catalystUserId,
        );
        const issuanceAccount = await ensureLeaderIdIssuanceAccount(transaction, context);
        const verifiedQualifyingEventIds = requiredEventIds.filter((eventId) =>
          qualifyingStatuses.has(resultByEvent.get(eventId)?.status ?? ''),
        );
        const posted = await postLedgerTransaction(transaction, context, {
          kind: 'leader_id_subscription_reward',
          idempotencyKey: input.idempotencyKey,
          requestHash: walletRequestHash({
            kind: 'leader_id_subscription_reward',
            programId: context.program.id,
            userId: input.catalystUserId,
            reason: leaderIdRewardReason,
            points: input.points,
            qualifyingEventIds: verifiedQualifyingEventIds,
          }),
          actorUserId: input.catalystUserId,
          subjectUserId: input.catalystUserId,
          reason: 'Награда за подключение Catalyst через Leader-ID',
          metadata: {
            leaderIdRewardReason,
            qualifyingEventIds: verifiedQualifyingEventIds,
          },
          entries: [
            { accountId: issuanceAccount.id, delta: -input.points },
            { accountId: userAccount.id, delta: input.points },
          ],
        });
        const [grant] = await database
          .insert(leaderIdRewardGrants)
          .values({
            userId: input.catalystUserId,
            programId: context.program.id,
            seasonId: context.season.id,
            reason: leaderIdRewardReason,
            transactionId: posted.transactionId,
            amount: input.points,
            qualifyingEventIds: verifiedQualifyingEventIds,
          })
          .returning();
        if (!grant) throw new Error('Leader-ID reward grant insert returned no row');
        await database
          .insert(outboxEvents)
          .values({
            type: 'reward.leader_id_subscription.granted',
            aggregateType: 'leader_id_reward_grant',
            aggregateId: grant.id,
            payload: {
              grantId: grant.id,
              transactionId: grant.transactionId,
              userId: grant.userId,
              programId: grant.programId,
              seasonId: grant.seasonId,
              reason: grant.reason,
              amount: grant.amount.toString(),
              qualifyingEventIds: verifiedQualifyingEventIds,
            },
          })
          .onConflictDoNothing();
        return {
          awarded: !posted.replayed,
          replayed: posted.replayed,
          points: grant.amount,
          transactionId: grant.transactionId,
        };
      });
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      const existing = await this.findGrant(input.catalystUserId, leaderIdRewardReason);
      if (!existing) throw error;
      return { ...existing, awarded: false, replayed: true };
    }
  }

  async findGrant(catalystUserId: string, reason: string): Promise<LeaderIdRewardGrant | null> {
    if (reason !== leaderIdRewardReason) return null;
    const [row] = await this.#database
      .select()
      .from(leaderIdRewardGrants)
      .where(
        and(
          eq(leaderIdRewardGrants.userId, catalystUserId),
          eq(leaderIdRewardGrants.reason, leaderIdRewardReason),
        ),
      )
      .limit(1);
    return row ? rewardGrant(row) : null;
  }
}

export const LEADER_ID_TELEGRAM_CHAT_INVITE_OUTBOX_TYPE = 'leader_id.telegram_chat_invite' as const;

export async function enqueueLeaderIdTelegramChatInvite(
  database: Database,
  catalystUserId: string,
): Promise<void> {
  await database
    .insert(outboxEvents)
    .values({
      type: LEADER_ID_TELEGRAM_CHAT_INVITE_OUTBOX_TYPE,
      aggregateType: 'user',
      aggregateId: catalystUserId,
      payload: { userId: catalystUserId },
      availableAt: new Date(),
    })
    .onConflictDoNothing();
}

export interface LeaderIdSubscriptionReconciliationSummary {
  totalBindings: number;
  succeeded: number;
  failed: number;
}

/**
 * Replays the idempotent subscription for every verified binding. Processing is deliberately
 * sequential to avoid bursts against the official Leader-ID API.
 */
export async function reconcileLeaderIdSubscriptions(input: {
  bindings: { listCatalystUserIds(): Promise<string[]> };
  service: { subscribe(catalystUserId: string): Promise<unknown> };
  onFailure?: (error: unknown) => void;
  onSuccess?: (catalystUserId: string) => Promise<void> | void;
}): Promise<LeaderIdSubscriptionReconciliationSummary> {
  const catalystUserIds = await input.bindings.listCatalystUserIds();
  let succeeded = 0;
  let failed = 0;
  for (const catalystUserId of catalystUserIds) {
    try {
      await input.service.subscribe(catalystUserId);
      await input.onSuccess?.(catalystUserId);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      input.onFailure?.(error);
    }
  }
  return { totalBindings: catalystUserIds.length, succeeded, failed };
}

export interface LeaderIdProductionConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  serverClientId: string;
  serverClientSecret: string;
  oauthRedirectUri: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  tokenKeyRing: LeaderIdTokenKeyRing;
  redisPrefix: string;
  environment?: 'production' | 'staging';
  oauthScope?: string;
  oauthStateTtlSeconds?: number;
  apiTimeoutMs?: number;
  leaseDurationMs?: number;
  leaseRenewEveryMs?: number;
  leaseAcquisitionWaitMs?: number;
}

export function createLeaderIdProduction(input: {
  database: Database;
  redis: Redis;
  config: LeaderIdProductionConfig;
}) {
  const redisCommands = input.redis as unknown as LeaderIdRedisCommands;
  const client = new OfficialLeaderIdClient({
    baseUrl:
      input.config.environment === 'staging'
        ? LEADER_ID_APPS_STAGING_BASE_URL
        : LEADER_ID_APPS_PRODUCTION_BASE_URL,
    ...(input.config.apiTimeoutMs === undefined ? {} : { timeoutMs: input.config.apiTimeoutMs }),
  });
  const stateRepository = new RedisLeaderIdOAuthStateRepository(
    redisCommands,
    input.config.redisPrefix,
  );
  const oauthState = new SecureLeaderIdOAuthStateManager({
    repository: stateRepository,
    ...(input.config.oauthStateTtlSeconds === undefined
      ? {}
      : { ttlSeconds: input.config.oauthStateTtlSeconds }),
  });
  const lease = new RedisLeaderIdUserLease({
    redis: redisCommands,
    redisPrefix: input.config.redisPrefix,
    ...(input.config.leaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: input.config.leaseDurationMs }),
    ...(input.config.leaseRenewEveryMs === undefined
      ? {}
      : { renewEveryMs: input.config.leaseRenewEveryMs }),
    ...(input.config.leaseAcquisitionWaitMs === undefined
      ? {}
      : { acquisitionWaitMs: input.config.leaseAcquisitionWaitMs }),
  });
  const bindings = new DrizzleLeaderIdBindingRepository(input.database);
  const eventsRegistry = new DrizzleCatalystLeaderIdEventRegistry(input.database);
  const registrations = new DrizzleLeaderIdRegistrationRepository(input.database, lease);
  const rewardPolicies = new DrizzleLeaderIdRewardPolicyProvider(input.database);
  const rewards = new DrizzleLeaderIdRewardIssuer(input.database);
  const service = new LeaderIdService({
    client,
    oauthState,
    tokenCipher: new AesGcmLeaderIdTokenCipher(input.config.tokenKeyRing),
    bindings,
    events: eventsRegistry,
    registrations,
    rewardPolicies,
    rewards,
    serverCredentials: {
      clientId: input.config.serverClientId,
      clientSecret: input.config.serverClientSecret,
    },
    oauth: {
      clientId: input.config.oauthClientId,
      clientSecret: input.config.oauthClientSecret,
      redirectUri: input.config.oauthRedirectUri,
      ...(input.config.oauthScope === undefined ? {} : { scope: input.config.oauthScope }),
    },
  });
  return {
    service,
    routes: createLeaderIdRoutes({
      service,
      successRedirectUrl: input.config.successRedirectUrl,
      failureRedirectUrl: input.config.failureRedirectUrl,
      onLinked: (catalystUserId) =>
        enqueueLeaderIdTelegramChatInvite(input.database, catalystUserId),
    }),
    adapters: {
      stateRepository,
      lease,
      bindings,
      events: eventsRegistry,
      registrations,
      rewardPolicies,
      rewards,
    },
  };
}
