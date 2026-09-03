import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '@cpi/db';
import {
  artifacts,
  eventRewardClaims,
  eventRewardPolicies,
  events,
  ledgerEntries,
  ledgerTransactions,
  outboxEvents,
  pointPrograms,
  pointSeasons,
  submissions,
  users,
  walletAccounts,
  walletSystemKeys,
} from '@cpi/db';
import { AppError } from '@cpi/shared';
import {
  artifactRewardIdempotencyKey,
  assertBalancedLedger,
  isWithinRewardWindow,
  MAX_POINTS_PER_OPERATION,
  serializePoints,
  walletRequestHash,
  type LedgerDelta,
} from './wallet-domain';

export type WalletTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ActiveWalletContext {
  program: typeof pointPrograms.$inferSelect;
  season: typeof pointSeasons.$inferSelect;
}

export interface LedgerPostInput {
  kind: typeof ledgerTransactions.$inferInsert.kind;
  idempotencyKey: string;
  requestHash: string;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  eventId?: string | null;
  submissionId?: string | null;
  relatedOrderId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  entries: LedgerDelta[];
}

export interface LedgerPostResult {
  transactionId: string;
  replayed: boolean;
}

function transactionDatabase(transaction: WalletTransaction): Database {
  // Drizzle's transaction exposes the same query surface used here, but intentionally omits
  // another top-level `transaction()` method from its public type.
  return transaction as unknown as Database;
}

export function walletProgramLockKey(programId: string): string {
  return `wallet-program:${programId}`;
}

export function walletQrSessionLockKey(qrSessionId: string): string {
  return `wallet-qr-session:${qrSessionId}`;
}

/**
 * Serializes every mutation of one wallet QR before row locks are taken. The programme lock is
 * deliberately first so an exclusive season reset cannot overlap a QR/intent mutation. The QR
 * advisory lock then makes the intent -> QR row order safe even while an intent is first being
 * attached to an active QR session.
 */
export async function lockWalletQrMutation(
  transaction: WalletTransaction,
  programId: string,
  qrSessionId: string,
): Promise<void> {
  const database = transactionDatabase(transaction);
  await database.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${walletProgramLockKey(programId)}, 0))`,
  );
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${walletQrSessionLockKey(qrSessionId)}, 0))`,
  );
}

async function assertContextStillActive(
  database: Database,
  context: ActiveWalletContext,
): Promise<void> {
  const [current] = await database
    .select({ activeSeasonId: pointPrograms.activeSeasonId })
    .from(pointPrograms)
    .where(eq(pointPrograms.id, context.program.id))
    .limit(1);
  if (!current || current.activeSeasonId !== context.season.id) {
    // A reset may switch seasons after a handler initially loaded its context. Mutating the
    // closed season would make that operation invisible in the active wallet, so make callers
    // retry against the new season instead.
    throw new AppError('POINT_SEASON_CHANGED', 'Сезон баллов обновился. Повторите операцию.', 409);
  }
}

export async function loadActiveWalletContext(database: Database): Promise<ActiveWalletContext> {
  const [row] = await database
    .select({ program: pointPrograms, season: pointSeasons })
    .from(pointPrograms)
    .innerJoin(pointSeasons, eq(pointSeasons.id, pointPrograms.activeSeasonId))
    .where(and(eq(pointPrograms.isDefault, true), eq(pointSeasons.status, 'active')))
    .limit(1);
  if (!row) {
    throw new AppError('POINT_PROGRAM_UNAVAILABLE', 'Программа баллов временно недоступна', 503);
  }
  return row;
}

export function validateProgramAmount(
  amount: bigint,
  program: Pick<typeof pointPrograms.$inferSelect, 'maxTransactionAmount'>,
): void {
  if (
    amount <= 0n ||
    amount > program.maxTransactionAmount ||
    amount > BigInt(MAX_POINTS_PER_OPERATION)
  ) {
    throw new AppError(
      'POINT_AMOUNT_LIMIT_EXCEEDED',
      `Максимальная сумма одной операции — ${serializePoints(program.maxTransactionAmount)}`,
      409,
    );
  }
}

async function ensureSystemAccount(
  transaction: WalletTransaction,
  context: ActiveWalletContext,
  input: {
    ownerKind: 'system_issuance' | 'system_redemption' | 'store';
    systemKey: string;
    title: string;
    allowNegative: boolean;
  },
): Promise<typeof walletAccounts.$inferSelect> {
  const database = transactionDatabase(transaction);
  await database
    .insert(walletAccounts)
    .values({
      programId: context.program.id,
      seasonId: context.season.id,
      ownerKind: input.ownerKind,
      systemKey: input.systemKey,
      title: input.title,
      allowNegative: input.allowNegative,
    })
    .onConflictDoNothing();
  const [account] = await database
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.programId, context.program.id),
        eq(walletAccounts.seasonId, context.season.id),
        eq(walletAccounts.systemKey, input.systemKey),
      ),
    )
    .limit(1);
  if (!account) throw new Error(`System wallet account ${input.systemKey} was not created`);
  return account;
}

async function ensureUserAccountInTransaction(
  transaction: WalletTransaction,
  context: ActiveWalletContext,
  userId: string,
): Promise<typeof walletAccounts.$inferSelect> {
  const database = transactionDatabase(transaction);
  await database.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${walletProgramLockKey(context.program.id)}, 0))`,
  );
  await assertContextStillActive(database, context);
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-user:${context.program.id}:${context.season.id}:${userId}`}, 0))`,
  );
  await database
    .insert(walletAccounts)
    .values({
      programId: context.program.id,
      seasonId: context.season.id,
      ownerKind: 'user',
      userId,
      title: 'Личный кошелёк',
      allowNegative: false,
    })
    .onConflictDoNothing();
  const [account] = await database
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.programId, context.program.id),
        eq(walletAccounts.seasonId, context.season.id),
        eq(walletAccounts.userId, userId),
        eq(walletAccounts.ownerKind, 'user'),
      ),
    )
    .limit(1);
  if (!account) throw new Error('User wallet account was not created');
  return account;
}

/**
 * The only primitive allowed to change a wallet balance. Accounts are locked in a stable order,
 * the request is protected by a transaction-scoped advisory lock, and both ledger sides plus the
 * cached balances are committed atomically.
 */
export async function postLedgerTransaction(
  transaction: WalletTransaction,
  context: ActiveWalletContext,
  input: LedgerPostInput,
): Promise<LedgerPostResult> {
  assertBalancedLedger(input.entries);
  const database = transactionDatabase(transaction);
  await database.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${walletProgramLockKey(context.program.id)}, 0))`,
  );
  await assertContextStillActive(database, context);
  const lockKey = `wallet-ledger:${context.program.id}:${input.idempotencyKey}`;
  await database.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  const [existing] = await database
    .select({ id: ledgerTransactions.id, requestHash: ledgerTransactions.requestHash })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.programId, context.program.id),
        eq(ledgerTransactions.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'Этот Idempotency-Key уже использован для другой операции',
        409,
      );
    }
    return { transactionId: existing.id, replayed: true };
  }

  const accountIds = [...new Set(input.entries.map((entry) => entry.accountId))].sort();
  const accounts = await database
    .select()
    .from(walletAccounts)
    .where(inArray(walletAccounts.id, accountIds))
    .orderBy(asc(walletAccounts.id))
    .for('update');
  if (accounts.length !== accountIds.length) {
    throw new AppError('WALLET_ACCOUNT_NOT_FOUND', 'Один из кошельков не найден', 404);
  }
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const balanceAfter = new Map<string, bigint>();
  for (const entry of input.entries) {
    const account = byId.get(entry.accountId)!;
    if (
      account.programId !== context.program.id ||
      account.seasonId !== context.season.id ||
      account.status !== 'active'
    ) {
      throw new AppError('WALLET_ACCOUNT_UNAVAILABLE', 'Кошелёк недоступен для операции', 409);
    }
    const next = account.balance + entry.delta;
    if (!account.allowNegative && next < 0n) {
      throw new AppError('INSUFFICIENT_POINTS', 'Недостаточно баллов', 409);
    }
    balanceAfter.set(account.id, next);
  }

  const [created] = await database
    .insert(ledgerTransactions)
    .values({
      programId: context.program.id,
      seasonId: context.season.id,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      actorUserId: input.actorUserId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      eventId: input.eventId ?? null,
      submissionId: input.submissionId ?? null,
      relatedOrderId: input.relatedOrderId ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: ledgerTransactions.id });
  if (!created) throw new Error('Ledger transaction insert returned no row');

  for (const accountId of accountIds) {
    await database
      .update(walletAccounts)
      .set({
        balance: balanceAfter.get(accountId)!,
        version: sql`${walletAccounts.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, accountId));
  }
  await database.insert(ledgerEntries).values(
    input.entries.map((entry) => ({
      transactionId: created.id,
      accountId: entry.accountId,
      delta: entry.delta,
      balanceAfter: balanceAfter.get(entry.accountId)!,
    })),
  );
  const [sealed] = await database
    .update(ledgerTransactions)
    .set({ sealedAt: sql`now()` })
    .where(and(eq(ledgerTransactions.id, created.id), isNull(ledgerTransactions.sealedAt)))
    .returning({ id: ledgerTransactions.id });
  if (!sealed) throw new Error('Ledger transaction seal returned no row');
  await database
    .insert(outboxEvents)
    .values({
      type: 'wallet.transaction.posted',
      aggregateType: 'ledger_transaction',
      aggregateId: created.id,
      payload: {
        transactionId: created.id,
        kind: input.kind,
        subjectUserId: input.subjectUserId ?? null,
      },
    })
    .onConflictDoNothing();
  return { transactionId: created.id, replayed: false };
}

export async function ensureWalletBootstrap(
  database: Database,
  userId: string,
): Promise<{
  context: ActiveWalletContext;
  account: typeof walletAccounts.$inferSelect;
}> {
  return database.transaction(async (transaction) => {
    const tx = transactionDatabase(transaction);
    const context = await loadActiveWalletContext(tx);
    const account = await ensureUserAccountInTransaction(transaction, context, userId);
    if (context.program.welcomeAmount > 0n) {
      const welcomeKey = `welcome:${context.program.id}:${userId}`;
      const [existingWelcome] = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(
          and(
            eq(ledgerTransactions.programId, context.program.id),
            eq(ledgerTransactions.idempotencyKey, welcomeKey),
          ),
        )
        .limit(1);
      if (existingWelcome) {
        const [fresh] = await tx
          .select()
          .from(walletAccounts)
          .where(eq(walletAccounts.id, account.id))
          .limit(1);
        if (!fresh) throw new Error('Bootstrapped wallet account disappeared');
        return { context, account: fresh };
      }
      const issuance = await ensureSystemAccount(transaction, context, {
        ownerKind: 'system_issuance',
        systemKey: walletSystemKeys.welcome,
        title: 'Стартовые начисления',
        allowNegative: true,
      });
      const amount = context.program.welcomeAmount;
      await postLedgerTransaction(transaction, context, {
        kind: 'welcome_grant',
        // Welcome is lifetime-per-program, not per season: a reset must not give all existing
        // participants another welcome grant when their new-season account is bootstrapped.
        idempotencyKey: welcomeKey,
        requestHash: walletRequestHash({
          kind: 'welcome_grant',
          programId: context.program.id,
          userId,
          amount,
        }),
        actorUserId: userId,
        subjectUserId: userId,
        reason: 'Стартовое начисление',
        entries: [
          { accountId: issuance.id, delta: -amount },
          { accountId: account.id, delta: amount },
        ],
      });
    }
    const [fresh] = await tx
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.id, account.id))
      .limit(1);
    if (!fresh) throw new Error('Bootstrapped wallet account disappeared');
    return { context, account: fresh };
  });
}

export async function ensureProgramSystemAccount(
  transaction: WalletTransaction,
  context: ActiveWalletContext,
  key: (typeof walletSystemKeys)[keyof typeof walletSystemKeys],
): Promise<typeof walletAccounts.$inferSelect> {
  if (
    key === walletSystemKeys.welcome ||
    key === walletSystemKeys.admin ||
    key === walletSystemKeys.leaderId
  ) {
    return ensureSystemAccount(transaction, context, {
      ownerKind: 'system_issuance',
      systemKey: key,
      title:
        key === walletSystemKeys.welcome
          ? 'Стартовые начисления'
          : key === walletSystemKeys.leaderId
            ? 'Награды Leader-ID'
            : 'Начисления сотрудников',
      allowNegative: true,
    });
  }
  if (key === walletSystemKeys.redemption) {
    return ensureSystemAccount(transaction, context, {
      ownerKind: 'system_redemption',
      systemKey: key,
      title: 'Погашение баллов',
      allowNegative: false,
    });
  }
  return ensureSystemAccount(transaction, context, {
    ownerKind: 'store',
    systemKey: key,
    title: 'Магазин',
    allowNegative: false,
  });
}

export async function ensureEventFundAccount(
  transaction: WalletTransaction,
  context: ActiveWalletContext,
  eventId: string,
  title?: string,
): Promise<typeof walletAccounts.$inferSelect> {
  const database = transactionDatabase(transaction);
  await database
    .insert(walletAccounts)
    .values({
      programId: context.program.id,
      seasonId: context.season.id,
      ownerKind: 'event',
      eventId,
      systemKey: `event:${eventId}`,
      title: title ?? 'Фонд мероприятия',
      // MVP has no configured event budget yet. A negative event fund keeps issuance visible in
      // double-entry accounting without inventing an arbitrary reward cap.
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
        eq(walletAccounts.ownerKind, 'event'),
        eq(walletAccounts.eventId, eventId),
      ),
    )
    .limit(1);
  if (!account) throw new Error('Event fund account was not created');
  return account;
}

export type ArtifactRewardResult =
  | { status: 'granted'; claimId: string; transactionId: string }
  | { status: 'already_granted'; claimId: string; transactionId: string }
  | { status: 'not_eligible' | 'manual_approval_required' };

/** Idempotent one-per-event artifact reward, usable by reconciliation endpoints. */
export async function grantArtifactReward(
  database: Database,
  input: { submissionId: string; allowManualPolicy?: boolean },
): Promise<ArtifactRewardResult> {
  const [candidate] = await database
    .select({ id: submissions.id, eventId: submissions.eventId, userId: submissions.userId })
    .from(submissions)
    .where(eq(submissions.id, input.submissionId))
    .limit(1);
  if (!candidate) return { status: 'not_eligible' };
  await ensureWalletBootstrap(database, candidate.userId);
  return database.transaction(async (transaction) => {
    const tx = transactionDatabase(transaction);
    const rewardKey = artifactRewardIdempotencyKey(candidate.eventId, candidate.userId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${rewardKey}, 0))`);
    const [locked] = await tx
      .select({ submission: submissions, policy: eventRewardPolicies, eventTitle: events.title })
      .from(submissions)
      .innerJoin(eventRewardPolicies, eq(eventRewardPolicies.eventId, submissions.eventId))
      .innerJoin(events, eq(events.id, submissions.eventId))
      .where(eq(submissions.id, candidate.id))
      .for('update')
      .limit(1);
    if (
      !locked ||
      locked.submission.status !== 'ready' ||
      locked.submission.deletedAt ||
      !locked.policy.enabled
    ) {
      return { status: 'not_eligible' as const };
    }
    if (locked.policy.requiresManualApproval && !input.allowManualPolicy) {
      return { status: 'manual_approval_required' as const };
    }
    const [readyArtifact] = await tx
      .select({ id: artifacts.id, readyAt: artifacts.readyAt })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.submissionId, locked.submission.id),
          eq(artifacts.status, 'ready'),
          isNull(artifacts.deletedAt),
        ),
      )
      .for('share')
      .limit(1);
    // A text-only ready submission must never satisfy artifact_ready.
    if (!readyArtifact) return { status: 'not_eligible' as const };
    const eligibilityAt =
      locked.submission.submittedAt ?? readyArtifact.readyAt ?? locked.submission.updatedAt;
    if (!isWithinRewardWindow(eligibilityAt, locked.policy.validFrom, locked.policy.validUntil)) {
      return { status: 'not_eligible' as const };
    }
    const [existing] = await tx
      .select()
      .from(eventRewardClaims)
      .where(
        and(
          eq(eventRewardClaims.eventId, locked.submission.eventId),
          eq(eventRewardClaims.userId, locked.submission.userId),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        status: 'already_granted' as const,
        claimId: existing.id,
        transactionId: existing.transactionId,
      };
    }
    const context = await loadActiveWalletContext(tx);
    if (context.program.id !== locked.policy.programId) return { status: 'not_eligible' as const };
    // A reset is a hard balance fence: an outbox event that was delayed from the closed season
    // must not resurrect points in the new zeroed season. Reconciliation remains available for
    // artifacts completed inside the current season.
    if (context.season.startsAt && eligibilityAt < context.season.startsAt) {
      return { status: 'not_eligible' as const };
    }
    validateProgramAmount(locked.policy.amount, context.program);
    const userAccount = await ensureUserAccountInTransaction(
      transaction,
      context,
      locked.submission.userId,
    );
    const fundAccount = await ensureEventFundAccount(
      transaction,
      context,
      locked.submission.eventId,
      `Фонд: ${locked.eventTitle}`,
    );
    const posted = await postLedgerTransaction(transaction, context, {
      kind: 'artifact_reward',
      idempotencyKey: rewardKey,
      requestHash: walletRequestHash({
        policyId: locked.policy.id,
        eventId: locked.submission.eventId,
        userId: locked.submission.userId,
        amount: locked.policy.amount,
      }),
      subjectUserId: locked.submission.userId,
      eventId: locked.submission.eventId,
      submissionId: locked.submission.id,
      reason: `Награда за артефакт: ${locked.eventTitle}`,
      metadata: { rewardPolicyId: locked.policy.id },
      entries: [
        { accountId: fundAccount.id, delta: -locked.policy.amount },
        { accountId: userAccount.id, delta: locked.policy.amount },
      ],
    });
    const [claim] = await tx
      .insert(eventRewardClaims)
      .values({
        policyId: locked.policy.id,
        programId: context.program.id,
        eventId: locked.submission.eventId,
        userId: locked.submission.userId,
        submissionId: locked.submission.id,
        transactionId: posted.transactionId,
        amountSnapshot: locked.policy.amount,
      })
      .returning({ id: eventRewardClaims.id });
    if (!claim) throw new Error('Artifact reward claim insert returned no row');
    await tx
      .insert(outboxEvents)
      .values({
        type: 'reward.artifact.granted',
        aggregateType: 'event_reward_claim',
        aggregateId: claim.id,
        payload: {
          claimId: claim.id,
          transactionId: posted.transactionId,
          userId: locked.submission.userId,
          eventId: locked.submission.eventId,
          amount: locked.policy.amount.toString(),
        },
      })
      .onConflictDoNothing();
    return { status: 'granted' as const, claimId: claim.id, transactionId: posted.transactionId };
  });
}

export async function ensureUserWalletAccount(
  transaction: WalletTransaction,
  context: ActiveWalletContext,
  userId: string,
): Promise<typeof walletAccounts.$inferSelect> {
  return ensureUserAccountInTransaction(transaction, context, userId);
}

export async function walletSnapshot(database: Database, userId: string) {
  const { context, account } = await ensureWalletBootstrap(database, userId);
  return {
    program: {
      id: context.program.id,
      code: context.program.code,
      walletTitle: context.program.walletTitle,
      unitOne: context.program.unitOne,
      unitFew: context.program.unitFew,
      unitMany: context.program.unitMany,
      symbol: context.program.symbol,
      iconUrl: context.program.iconUrl,
      p2pEnabled: context.program.p2pEnabled,
      storeEnabled: context.program.storeEnabled,
      maxTransactionAmount: serializePoints(context.program.maxTransactionAmount),
    },
    season: { id: context.season.id, code: context.season.code, title: context.season.title },
    account: {
      id: account.id,
      balance: serializePoints(account.balance),
      status: account.status,
    },
  };
}

export async function walletHistory(
  database: Database,
  userId: string,
  options: { beforeId?: number; limit: number },
) {
  const { context } = await ensureWalletBootstrap(database, userId);
  const userAccounts = await database
    .select({ id: walletAccounts.id })
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.programId, context.program.id),
        eq(walletAccounts.ownerKind, 'user'),
        eq(walletAccounts.userId, userId),
      ),
    );
  const userAccountIds = userAccounts.map((account) => account.id);
  if (userAccountIds.length === 0) return { items: [], nextBeforeId: null };
  const rows = await database
    .select({ entry: ledgerEntries, transaction: ledgerTransactions })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        inArray(ledgerEntries.accountId, userAccountIds),
        options.beforeId === undefined ? undefined : lt(ledgerEntries.id, options.beforeId),
      ),
    )
    .orderBy(desc(ledgerEntries.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const transactionIds = page.map((row) => row.transaction.id);
  const otherEntries =
    transactionIds.length === 0
      ? []
      : await database
          .select({
            transactionId: ledgerEntries.transactionId,
            accountId: walletAccounts.id,
            ownerKind: walletAccounts.ownerKind,
            title: walletAccounts.title,
            userId: walletAccounts.userId,
          })
          .from(ledgerEntries)
          .innerJoin(walletAccounts, eq(walletAccounts.id, ledgerEntries.accountId))
          .where(
            and(
              inArray(ledgerEntries.transactionId, transactionIds),
              sql`${ledgerEntries.accountId} not in (${sql.join(
                userAccountIds.map((accountId) => sql`${accountId}`),
                sql`, `,
              )})`,
            ),
          );
  const counterpartUserIds = [
    ...new Set(otherEntries.flatMap((entry) => (entry.userId ? [entry.userId] : []))),
  ];
  const actorUserIds = page.flatMap(({ transaction }) =>
    transaction.actorUserId ? [transaction.actorUserId] : [],
  );
  const publicUserIds = [...new Set([...counterpartUserIds, ...actorUserIds])];
  const counterpartUsers =
    publicUserIds.length === 0
      ? []
      : await database
          .select({
            id: users.id,
            fullName: users.fullName,
            firstName: users.telegramFirstName,
            lastName: users.telegramLastName,
            username: users.telegramUsername,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(inArray(users.id, publicUserIds));
  const publicUsers = new Map(
    counterpartUsers.map((user) => [
      user.id,
      {
        id: user.id,
        displayName:
          user.fullName ??
          ([user.firstName, user.lastName].filter(Boolean).join(' ') || 'Участник'),
        username: user.username,
        avatarUrl: user.avatarUrl,
      },
    ]),
  );
  const counterparts = new Map(
    otherEntries.map((entry) => [
      entry.transactionId,
      entry.userId
        ? (publicUsers.get(entry.userId) ?? {
            id: entry.userId,
            displayName: 'Участник',
            username: null,
            avatarUrl: null,
          })
        : {
            id: null,
            displayName: entry.title,
            username: null,
            avatarUrl: null,
            accountKind: entry.ownerKind,
          },
    ]),
  );
  return {
    items: page.map(({ entry, transaction }) => ({
      entryId: entry.id,
      transactionId: transaction.id,
      kind: transaction.kind,
      delta: serializePoints(entry.delta),
      balanceAfter: serializePoints(entry.balanceAfter),
      reason: transaction.reason,
      eventId: transaction.eventId,
      orderId: transaction.relatedOrderId,
      createdAt: transaction.createdAt,
      counterpart: counterparts.get(transaction.id) ?? null,
      actor: transaction.actorUserId ? (publicUsers.get(transaction.actorUserId) ?? null) : null,
    })),
    nextBeforeId: rows.length > options.limit ? (page.at(-1)?.entry.id ?? null) : null,
  };
}
