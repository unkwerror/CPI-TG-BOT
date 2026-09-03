import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, count, countDistinct, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  artifacts,
  eventRewardClaims,
  eventRewardPolicies,
  events,
  ledgerEntries,
  ledgerTransactions,
  pointFundAccess,
  pointPrograms,
  pointSeasons,
  qrSessions,
  storeOrders,
  submissions,
  users,
  walletAccounts,
  walletIntents,
  walletResetJobs,
  walletSystemKeys,
} from '@cpi/db';
import { AppError } from '@cpi/shared';
import { writeAudit } from '../audit';
import {
  requireIdempotencyKey,
  serializePoints,
  signedPointsToBigInt,
  walletRequestHash,
} from '../wallet-domain';
import {
  ensureEventFundAccount,
  ensureProgramSystemAccount,
  ensureUserWalletAccount,
  ensureWalletBootstrap,
  grantArtifactReward,
  loadActiveWalletContext,
  postLedgerTransaction,
  validateProgramAmount,
  walletProgramLockKey,
} from '../wallet-service';

const uuidParams = z.object({ id: z.uuid() });
const userParams = z.object({ userId: z.uuid() });
const eventParams = z.object({ eventId: z.uuid() });
const unsignedPointInput = z
  .union([
    z.number().int(),
    z
      .string()
      .trim()
      .regex(/^\d{1,10}$/),
  ])
  .transform((value) => (typeof value === 'number' ? value : Number(value)))
  .pipe(z.number().int().min(0).max(1_000_000_000));
const positivePointInput = unsignedPointInput.refine((value) => value > 0, {
  message: 'Количество баллов должно быть больше нуля',
});
const signedPointInput = z
  .union([
    z.number().int(),
    z
      .string()
      .trim()
      .regex(/^-?\d{1,10}$/),
  ])
  .transform((value) => (typeof value === 'number' ? value : Number(value)))
  .pipe(z.number().int().min(-1_000_000_000).max(1_000_000_000));

const settingsSchema = z
  .object({
    walletTitle: z.string().trim().min(2).max(100).optional(),
    unitOne: z.string().trim().min(1).max(30).optional(),
    unitFew: z.string().trim().min(1).max(30).optional(),
    unitMany: z.string().trim().min(1).max(30).optional(),
    symbol: z.string().trim().max(20).nullable().optional(),
    iconUrl: z.url().max(2_000).nullable().optional(),
    welcomeAmount: unsignedPointInput.optional(),
    leaderIdSubscriptionReward: unsignedPointInput.optional(),
    openingBalance: unsignedPointInput.optional(),
    maxTransactionAmount: positivePointInput.optional(),
    qrTtlSeconds: z.number().int().min(15).max(600).optional(),
    intentTtlSeconds: z.number().int().min(15).max(900).optional(),
    p2pEnabled: z.boolean().optional(),
    storeEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Нет изменений' });

const adjustmentSchema = z.object({
  userId: z.uuid(),
  amount: signedPointInput,
  reason: z.string().trim().min(5).max(500),
});
const accessSchema = z
  .object({
    canCredit: z.boolean(),
    canDebit: z.boolean(),
    canView: z.boolean(),
  })
  .refine((value) => value.canCredit || value.canDebit || value.canView, {
    message: 'Выберите хотя бы одно разрешение',
  });
const rewardPolicySchema = z
  .object({
    amount: positivePointInput,
    enabled: z.boolean(),
    requiresManualApproval: z.boolean().default(false),
    validFrom: z.iso.datetime({ offset: true }).nullable().optional(),
    validUntil: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.validFrom &&
      value.validUntil &&
      new Date(value.validUntil) < new Date(value.validFrom)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Дата окончания должна быть позже даты начала',
      });
    }
  });
const reconcileSchema = z.object({ execute: z.boolean().default(false) });
const resetPreviewSchema = z.object({
  targetOpeningAmount: unsignedPointInput
    .refine((value) => value === 0, {
      message: 'В этом релизе сброс выполняется только до нуля',
    })
    .default(0),
  reason: z.string().trim().min(10).max(1_000),
});
const resetConfirmSchema = z.object({ confirmation: z.string().trim().min(1).max(100) });

function bigintValue(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
  return 0n;
}

function serializeSettings(program: typeof pointPrograms.$inferSelect) {
  return {
    id: program.id,
    code: program.code,
    walletTitle: program.walletTitle,
    unitOne: program.unitOne,
    unitFew: program.unitFew,
    unitMany: program.unitMany,
    symbol: program.symbol,
    iconUrl: program.iconUrl,
    welcomeAmount: serializePoints(program.welcomeAmount),
    leaderIdSubscriptionReward: serializePoints(program.leaderIdSubscriptionReward),
    openingBalance: serializePoints(program.welcomeAmount),
    maxTransactionAmount: serializePoints(program.maxTransactionAmount),
    qrTtlSeconds: program.qrTtlSeconds,
    intentTtlSeconds: program.intentTtlSeconds,
    p2pEnabled: program.p2pEnabled,
    storeEnabled: program.storeEnabled,
    activeSeasonId: program.activeSeasonId,
  };
}

export const adminWalletRoutes: FastifyPluginAsync = async (app) => {
  const readGuards = [app.requireAuth, app.requireAdmin];
  const writeGuards = [app.requireAuth, app.requireCsrf, app.requireAdmin];

  app.get(
    '/admin/wallet/settings',
    { preHandler: readGuards, schema: { tags: ['admin', 'wallet'] } },
    async () => serializeSettings((await loadActiveWalletContext(app.db)).program),
  );

  app.patch(
    '/admin/wallet/settings',
    { preHandler: writeGuards, schema: { tags: ['admin', 'wallet'] } },
    async (request) => {
      const body = settingsSchema.parse(request.body);
      const { program } = await loadActiveWalletContext(app.db);
      if (
        body.welcomeAmount !== undefined &&
        body.openingBalance !== undefined &&
        body.welcomeAmount !== body.openingBalance
      ) {
        throw new AppError(
          'WELCOME_AMOUNT_CONFLICT',
          'welcomeAmount и openingBalance должны совпадать',
          400,
        );
      }
      const requestedWelcome = body.welcomeAmount ?? body.openingBalance;
      const welcomeAmount = BigInt(requestedWelcome ?? program.welcomeAmount);
      const maxTransactionAmount = BigInt(
        body.maxTransactionAmount ?? program.maxTransactionAmount,
      );
      const leaderIdSubscriptionReward = BigInt(
        body.leaderIdSubscriptionReward ?? program.leaderIdSubscriptionReward,
      );
      if (welcomeAmount > maxTransactionAmount) {
        throw new AppError(
          'WELCOME_AMOUNT_TOO_LARGE',
          'Стартовое начисление не может превышать лимит одной операции',
          400,
        );
      }
      if (leaderIdSubscriptionReward > maxTransactionAmount) {
        throw new AppError(
          'LEADER_ID_REWARD_TOO_LARGE',
          'Награда Leader-ID не может превышать лимит одной операции',
          400,
        );
      }
      const [updated] = await app.db
        .update(pointPrograms)
        .set({
          ...(body.walletTitle === undefined ? {} : { walletTitle: body.walletTitle }),
          ...(body.unitOne === undefined ? {} : { unitOne: body.unitOne }),
          ...(body.unitFew === undefined ? {} : { unitFew: body.unitFew }),
          ...(body.unitMany === undefined ? {} : { unitMany: body.unitMany }),
          ...(body.symbol === undefined ? {} : { symbol: body.symbol }),
          ...(body.iconUrl === undefined ? {} : { iconUrl: body.iconUrl }),
          ...(requestedWelcome === undefined ? {} : { welcomeAmount }),
          ...(body.leaderIdSubscriptionReward === undefined ? {} : { leaderIdSubscriptionReward }),
          ...(body.maxTransactionAmount === undefined ? {} : { maxTransactionAmount }),
          ...(body.qrTtlSeconds === undefined ? {} : { qrTtlSeconds: body.qrTtlSeconds }),
          ...(body.intentTtlSeconds === undefined
            ? {}
            : { intentTtlSeconds: body.intentTtlSeconds }),
          ...(body.p2pEnabled === undefined ? {} : { p2pEnabled: body.p2pEnabled }),
          ...(body.storeEnabled === undefined ? {} : { storeEnabled: body.storeEnabled }),
          updatedAt: new Date(),
        })
        .where(eq(pointPrograms.id, program.id))
        .returning();
      if (!updated) throw new Error('Point programme disappeared');
      await writeAudit(request, {
        action: 'wallet.settings.update',
        entityType: 'point_program',
        entityId: program.id,
        metadata: { changedFields: Object.keys(body) },
      });
      return serializeSettings(updated);
    },
  );

  app.get(
    '/admin/wallet/dashboard',
    { preHandler: readGuards, schema: { tags: ['admin', 'wallet'] } },
    async () => {
      const { program, season } = await loadActiveWalletContext(app.db);
      const now = new Date();
      const novosibirsk = new Date(now.getTime() + 7 * 60 * 60 * 1_000);
      const localDayStart = new Date(
        Date.UTC(
          novosibirsk.getUTCFullYear(),
          novosibirsk.getUTCMonth(),
          novosibirsk.getUTCDate(),
        ) -
          7 * 60 * 60 * 1_000,
      );
      const [
        accounts,
        transactions,
        claims,
        orders,
        paidOrders,
        intents,
        allBalances,
        today,
        reconciliationMismatches,
      ] = await Promise.all([
        app.db
          .select({
            count: count(),
            balance: sql<bigint>`coalesce(sum(${walletAccounts.balance}), 0)::bigint`,
          })
          .from(walletAccounts)
          .where(and(eq(walletAccounts.seasonId, season.id), eq(walletAccounts.ownerKind, 'user'))),
        app.db
          .select({ count: count() })
          .from(ledgerTransactions)
          .where(eq(ledgerTransactions.seasonId, season.id)),
        app.db
          .select({ count: count() })
          .from(eventRewardClaims)
          .where(eq(eventRewardClaims.programId, program.id)),
        app.db
          .select({
            count: count(),
            spent: sql<bigint>`coalesce(sum(${storeOrders.totalPoints}), 0)::bigint`,
          })
          .from(storeOrders)
          .where(eq(storeOrders.programId, program.id)),
        app.db
          .select({ count: count() })
          .from(storeOrders)
          .where(
            and(
              eq(storeOrders.programId, program.id),
              inArray(storeOrders.status, ['paid', 'pickup_requested', 'ready_for_pickup']),
            ),
          ),
        app.db
          .select({ count: count() })
          .from(walletIntents)
          .where(
            and(
              eq(walletIntents.seasonId, season.id),
              inArray(walletIntents.status, [
                'awaiting_initiator_confirmation',
                'awaiting_owner_confirmation',
              ]),
            ),
          ),
        app.db
          .select({ balance: sql<bigint>`coalesce(sum(${walletAccounts.balance}), 0)::bigint` })
          .from(walletAccounts)
          .where(eq(walletAccounts.seasonId, season.id)),
        app.db
          .select({
            credited: sql<bigint>`coalesce(sum(case when ${ledgerEntries.delta} > 0 then ${ledgerEntries.delta} else 0 end), 0)::bigint`,
            debited: sql<bigint>`coalesce(sum(case when ${ledgerEntries.delta} < 0 then -${ledgerEntries.delta} else 0 end), 0)::bigint`,
          })
          .from(ledgerEntries)
          .innerJoin(walletAccounts, eq(walletAccounts.id, ledgerEntries.accountId))
          .where(
            and(
              eq(walletAccounts.seasonId, season.id),
              eq(walletAccounts.ownerKind, 'user'),
              sql`${ledgerEntries.createdAt} >= ${localDayStart}`,
            ),
          ),
        app.db
          .select({
            accountId: walletAccounts.id,
            cachedBalance: walletAccounts.balance,
            ledgerBalance: sql<bigint>`coalesce(sum(${ledgerEntries.delta}), 0)::bigint`,
          })
          .from(walletAccounts)
          .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, walletAccounts.id))
          .where(eq(walletAccounts.seasonId, season.id))
          .groupBy(walletAccounts.id, walletAccounts.balance)
          .having(
            sql`${walletAccounts.balance} <> coalesce(sum(${ledgerEntries.delta}), 0)::bigint`,
          ),
      ]);
      const ledgerNet = bigintValue(allBalances[0]?.balance);
      const ledgerReconciled = reconciliationMismatches.length === 0;
      return {
        program: serializeSettings(program),
        season: { id: season.id, code: season.code, title: season.title },
        users: Number(accounts[0]?.count ?? 0),
        activeWallets: Number(accounts[0]?.count ?? 0),
        circulatingBalance: serializePoints(bigintValue(accounts[0]?.balance)),
        ledgerTransactions: Number(transactions[0]?.count ?? 0),
        artifactRewards: Number(claims[0]?.count ?? 0),
        orders: Number(orders[0]?.count ?? 0),
        paidOrders: Number(paidOrders[0]?.count ?? 0),
        creditedToday: serializePoints(bigintValue(today[0]?.credited)),
        debitedToday: serializePoints(bigintValue(today[0]?.debited)),
        dayTimezone: 'Asia/Novosibirsk',
        storeSpent: serializePoints(bigintValue(orders[0]?.spent)),
        pendingIntents: Number(intents[0]?.count ?? 0),
        ledgerNet: serializePoints(ledgerNet),
        ledgerBalanced: ledgerNet === 0n && ledgerReconciled,
        ledgerReconciled,
        ledgerMismatchAccounts: reconciliationMismatches.length,
        ledgerMismatchSample: reconciliationMismatches.slice(0, 10).map((row) => ({
          accountId: row.accountId,
          cachedBalance: serializePoints(bigintValue(row.cachedBalance)),
          ledgerBalance: serializePoints(bigintValue(row.ledgerBalance)),
        })),
      };
    },
  );

  app.post(
    '/admin/wallet/adjustments',
    { preHandler: writeGuards, schema: { tags: ['admin', 'wallet'] } },
    async (request, reply) => {
      const body = adjustmentSchema.parse(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const signedAmount = signedPointsToBigInt(body.amount);
      const absoluteAmount = signedAmount < 0n ? -signedAmount : signedAmount;
      await ensureWalletBootstrap(app.db, body.userId);
      const posted = await app.db.transaction(async (transaction) => {
        const context = await loadActiveWalletContext(transaction as unknown as typeof app.db);
        validateProgramAmount(absoluteAmount, context.program);
        const userAccount = await ensureUserWalletAccount(transaction, context, body.userId);
        const systemAccount = await ensureProgramSystemAccount(
          transaction,
          context,
          signedAmount > 0n ? walletSystemKeys.admin : walletSystemKeys.redemption,
        );
        return postLedgerTransaction(transaction, context, {
          kind: 'admin_adjustment',
          idempotencyKey: `admin-adjustment:${idempotencyKey}`,
          requestHash: walletRequestHash({
            userId: body.userId,
            amount: signedAmount,
            reason: body.reason,
          }),
          actorUserId: request.currentUser!.id,
          subjectUserId: body.userId,
          reason: body.reason,
          entries:
            signedAmount > 0n
              ? [
                  { accountId: systemAccount.id, delta: -signedAmount },
                  { accountId: userAccount.id, delta: signedAmount },
                ]
              : [
                  { accountId: userAccount.id, delta: signedAmount },
                  { accountId: systemAccount.id, delta: -signedAmount },
                ],
        });
      });
      await writeAudit(request, {
        action: 'wallet.adjustment.create',
        entityType: 'ledger_transaction',
        entityId: posted.transactionId,
        metadata: {
          subjectUserId: body.userId,
          amount: serializePoints(signedAmount),
          reason: body.reason,
          replayed: posted.replayed,
        },
      });
      return reply.code(posted.replayed ? 200 : 201).send({
        transactionId: posted.transactionId,
        amount: serializePoints(signedAmount),
        replayed: posted.replayed,
      });
    },
  );

  app.get(
    '/admin/wallet/fund-access',
    { preHandler: readGuards, schema: { tags: ['admin', 'wallet'] } },
    async () => {
      const { program } = await loadActiveWalletContext(app.db);
      const rows = await app.db
        .select({ access: pointFundAccess, user: users })
        .from(pointFundAccess)
        .innerJoin(users, eq(users.id, pointFundAccess.userId))
        .where(and(eq(pointFundAccess.programId, program.id), isNull(pointFundAccess.revokedAt)))
        .orderBy(asc(users.fullName), asc(users.id));
      return {
        items: rows.map(({ access, user }) => ({
          userId: user.id,
          displayName:
            user.fullName ??
            ([user.telegramFirstName, user.telegramLastName].filter(Boolean).join(' ') ||
              'Участник'),
          username: user.telegramUsername,
          canCredit: access.canCredit,
          canDebit: access.canDebit,
          canView: access.canView,
          updatedAt: access.updatedAt,
        })),
      };
    },
  );

  app.get(
    '/admin/wallet/fund-access/:userId',
    { preHandler: readGuards, schema: { tags: ['admin', 'wallet'] } },
    async (request) => {
      const { userId } = userParams.parse(request.params);
      const { program } = await loadActiveWalletContext(app.db);
      const [access] = await app.db
        .select()
        .from(pointFundAccess)
        .where(
          and(
            eq(pointFundAccess.programId, program.id),
            eq(pointFundAccess.userId, userId),
            isNull(pointFundAccess.revokedAt),
          ),
        )
        .limit(1);
      return {
        userId,
        canCredit: access?.canCredit ?? false,
        canDebit: access?.canDebit ?? false,
        canView: access?.canView ?? false,
        updatedAt: access?.updatedAt ?? null,
      };
    },
  );

  app.put(
    '/admin/wallet/fund-access/:userId',
    { preHandler: writeGuards, schema: { tags: ['admin', 'wallet'] } },
    async (request) => {
      const { userId } = userParams.parse(request.params);
      const body = accessSchema.parse(request.body);
      const { program } = await loadActiveWalletContext(app.db);
      const [user] = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new AppError('USER_NOT_FOUND', 'Пользователь не найден', 404);
      const [access] = await app.db
        .insert(pointFundAccess)
        .values({
          programId: program.id,
          userId,
          ...body,
          grantedBy: request.currentUser!.id,
        })
        .onConflictDoUpdate({
          target: [pointFundAccess.programId, pointFundAccess.userId],
          set: {
            ...body,
            grantedBy: request.currentUser!.id,
            revokedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!access) throw new Error('Fund access insert returned no row');
      await writeAudit(request, {
        action: 'wallet.fund_access.grant',
        entityType: 'point_fund_access',
        entityId: access.id,
        metadata: { userId, ...body },
      });
      return access;
    },
  );

  app.delete(
    '/admin/wallet/fund-access/:userId',
    { preHandler: writeGuards, schema: { tags: ['admin', 'wallet'] } },
    async (request, reply) => {
      const { userId } = userParams.parse(request.params);
      const { program } = await loadActiveWalletContext(app.db);
      const [access] = await app.db
        .update(pointFundAccess)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(pointFundAccess.programId, program.id),
            eq(pointFundAccess.userId, userId),
            isNull(pointFundAccess.revokedAt),
          ),
        )
        .returning({ id: pointFundAccess.id });
      if (!access) throw new AppError('FUND_ACCESS_NOT_FOUND', 'Доступ уже отозван', 404);
      await writeAudit(request, {
        action: 'wallet.fund_access.revoke',
        entityType: 'point_fund_access',
        entityId: access.id,
        metadata: { userId },
      });
      return reply.code(204).send();
    },
  );

  app.put(
    '/admin/events/:eventId/reward-policy',
    { preHandler: writeGuards, schema: { tags: ['admin', 'events', 'wallet'] } },
    async (request) => {
      const { eventId } = eventParams.parse(request.params);
      const body = rewardPolicySchema.parse(request.body);
      const amount = BigInt(body.amount);
      const context = await loadActiveWalletContext(app.db);
      validateProgramAmount(amount, context.program);
      const [event] = await app.db
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
        .limit(1);
      if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
      const policy = await app.db.transaction(async (transaction) => {
        await ensureEventFundAccount(transaction, context, event.id, `Фонд: ${event.title}`);
        const [saved] = await transaction
          .insert(eventRewardPolicies)
          .values({
            eventId,
            programId: context.program.id,
            amount,
            enabled: body.enabled,
            requiresManualApproval: body.requiresManualApproval,
            validFrom: body.validFrom ? new Date(body.validFrom) : null,
            validUntil: body.validUntil ? new Date(body.validUntil) : null,
            createdBy: request.currentUser!.id,
            updatedBy: request.currentUser!.id,
          })
          .onConflictDoUpdate({
            target: eventRewardPolicies.eventId,
            set: {
              amount,
              enabled: body.enabled,
              requiresManualApproval: body.requiresManualApproval,
              validFrom: body.validFrom ? new Date(body.validFrom) : null,
              validUntil: body.validUntil ? new Date(body.validUntil) : null,
              updatedBy: request.currentUser!.id,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!saved) throw new Error('Reward policy upsert returned no row');
        return saved;
      });
      await writeAudit(request, {
        action: 'event.reward_policy.update',
        entityType: 'event_reward_policy',
        entityId: policy.id,
        eventId,
        metadata: {
          amount: serializePoints(policy.amount),
          enabled: policy.enabled,
          requiresManualApproval: policy.requiresManualApproval,
        },
      });
      return { ...policy, amount: serializePoints(policy.amount) };
    },
  );

  app.post(
    '/admin/events/:eventId/rewards/reconcile',
    { preHandler: writeGuards, schema: { tags: ['admin', 'events', 'wallet'] } },
    async (request) => {
      const { eventId } = eventParams.parse(request.params);
      const body = reconcileSchema.parse(request.body ?? {});
      const [policy] = await app.db
        .select()
        .from(eventRewardPolicies)
        .where(eq(eventRewardPolicies.eventId, eventId))
        .limit(1);
      if (!policy)
        throw new AppError('REWARD_POLICY_NOT_FOUND', 'Правило награды не настроено', 404);
      const eligible = await app.db
        .select({ submissionId: submissions.id, userId: submissions.userId })
        .from(submissions)
        .innerJoin(
          artifacts,
          and(
            eq(artifacts.submissionId, submissions.id),
            eq(artifacts.status, 'ready'),
            isNull(artifacts.deletedAt),
          ),
        )
        .leftJoin(
          eventRewardClaims,
          and(
            eq(eventRewardClaims.eventId, submissions.eventId),
            eq(eventRewardClaims.userId, submissions.userId),
          ),
        )
        .where(
          and(
            eq(submissions.eventId, eventId),
            eq(submissions.status, 'ready'),
            isNull(submissions.deletedAt),
            isNull(eventRewardClaims.id),
          ),
        )
        .groupBy(submissions.id, submissions.userId)
        .orderBy(asc(submissions.createdAt))
        .limit(1_000);
      const [rewardedSummary] = await app.db
        .select({ users: countDistinct(eventRewardClaims.userId) })
        .from(eventRewardClaims)
        .where(eq(eventRewardClaims.eventId, eventId));
      const alreadyRewarded = Number(rewardedSummary?.users ?? 0);
      if (!body.execute) {
        const eligibleUsers = new Set(eligible.map((row) => row.userId)).size;
        return {
          execute: false,
          eligible: eligibleUsers,
          eligibleUsers,
          alreadyRewarded,
          eligibleSubmissions: eligible.length,
          amountEach: serializePoints(policy.amount),
        };
      }
      const byUser = new Map<string, string>();
      for (const row of eligible)
        if (!byUser.has(row.userId)) byUser.set(row.userId, row.submissionId);
      let granted = 0;
      let skipped = 0;
      for (const submissionId of byUser.values()) {
        const result = await grantArtifactReward(app.db, {
          submissionId,
          allowManualPolicy: true,
        });
        if (result.status === 'granted') granted += 1;
        else skipped += 1;
      }
      await writeAudit(request, {
        action: 'event.rewards.reconcile',
        entityType: 'event_reward_policy',
        entityId: policy.id,
        eventId,
        metadata: { eligible: byUser.size, granted, skipped },
      });
      return {
        execute: true,
        eligible: byUser.size,
        eligibleUsers: byUser.size,
        alreadyRewarded,
        granted,
        skipped,
      };
    },
  );

  app.post(
    '/admin/wallet/resets/preview',
    { preHandler: writeGuards, schema: { tags: ['admin', 'wallet'] } },
    async (request, reply) => {
      const body = resetPreviewSchema.parse(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const { program, season } = await loadActiveWalletContext(app.db);
      const [summary] = await app.db
        .select({
          accounts: count(),
          total: sql<bigint>`coalesce(sum(${walletAccounts.balance}), 0)::bigint`,
        })
        .from(walletAccounts)
        .where(and(eq(walletAccounts.seasonId, season.id), eq(walletAccounts.ownerKind, 'user')));
      const [existing] = await app.db
        .select()
        .from(walletResetJobs)
        .where(
          and(
            eq(walletResetJobs.programId, program.id),
            eq(walletResetJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.reason !== body.reason ||
          existing.targetOpeningAmount !== BigInt(body.targetOpeningAmount)
        ) {
          throw new AppError(
            'IDEMPOTENCY_KEY_REUSED',
            'Этот Idempotency-Key уже использован для другого сброса',
            409,
          );
        }
        return reply.code(200).send({
          ...existing,
          targetOpeningAmount: serializePoints(existing.targetOpeningAmount),
          previousTotal: serializePoints(existing.previousTotal ?? 0n),
        });
      }
      const [job] = await app.db
        .insert(walletResetJobs)
        .values({
          programId: program.id,
          fromSeasonId: season.id,
          status: 'previewed',
          targetOpeningAmount: 0n,
          affectedAccounts: Number(summary?.accounts ?? 0),
          previousTotal: bigintValue(summary?.total),
          reason: body.reason,
          idempotencyKey,
          createdBy: request.currentUser!.id,
          previewedAt: new Date(),
        })
        .returning();
      if (!job) throw new Error('Reset preview insert returned no row');
      await writeAudit(request, {
        action: 'wallet.reset.preview',
        entityType: 'wallet_reset_job',
        entityId: job.id,
        metadata: {
          affectedAccounts: job.affectedAccounts,
          previousTotal: serializePoints(job.previousTotal ?? 0n),
        },
      });
      return reply.code(201).send({
        ...job,
        targetOpeningAmount: serializePoints(job.targetOpeningAmount),
        previousTotal: serializePoints(job.previousTotal ?? 0n),
        confirmation: job.id,
      });
    },
  );

  app.post(
    '/admin/wallet/resets/:id/confirm',
    { preHandler: writeGuards, schema: { tags: ['admin', 'wallet'] } },
    async (request) => {
      const { id } = uuidParams.parse(request.params);
      const body = resetConfirmSchema.parse(request.body);
      if (body.confirmation !== id) {
        throw new AppError('RESET_CONFIRMATION_INVALID', 'Введите идентификатор сброса', 400);
      }
      const completed = await app.db.transaction(async (transaction) => {
        const [jobCandidate] = await transaction
          .select()
          .from(walletResetJobs)
          .where(eq(walletResetJobs.id, id))
          .limit(1);
        if (!jobCandidate) throw new AppError('RESET_NOT_FOUND', 'Сброс не найден', 404);
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${walletProgramLockKey(jobCandidate.programId)}, 0))`,
        );
        // The users AFTER INSERT trigger takes FOR SHARE on the default programme before
        // bootstrapping a wallet. Taking the conflicting row lock here makes a concurrent new
        // user land wholly before the reset (and be zeroed) or wholly after it (and receive the
        // lifetime welcome grant in the new season), never half in each season.
        await transaction
          .select({ id: pointPrograms.id })
          .from(pointPrograms)
          .where(eq(pointPrograms.id, jobCandidate.programId))
          .for('update')
          .limit(1);
        const [job] = await transaction
          .select()
          .from(walletResetJobs)
          .where(eq(walletResetJobs.id, id))
          .for('update')
          .limit(1);
        if (!job) throw new AppError('RESET_NOT_FOUND', 'Сброс не найден', 404);
        if (job.status === 'completed') return job;
        if (job.status !== 'previewed') {
          throw new AppError('RESET_STATE_INVALID', 'Сброс нельзя выполнить в этом состоянии', 409);
        }
        const context = await loadActiveWalletContext(transaction as unknown as typeof app.db);
        if (context.program.id !== job.programId || context.season.id !== job.fromSeasonId) {
          throw new AppError('RESET_STALE', 'Активный сезон уже изменился', 409);
        }
        const now = new Date();
        await transaction
          .update(walletResetJobs)
          .set({
            status: 'executing',
            confirmedBy: request.currentUser!.id,
            confirmedAt: now,
            startedAt: now,
          })
          .where(eq(walletResetJobs.id, job.id));
        const [latestSeason] = await transaction
          .select({ count: count() })
          .from(pointSeasons)
          .where(eq(pointSeasons.programId, context.program.id));
        const sequence = Number(latestSeason?.count ?? 0) + 1;
        const newSeasonId = crypto.randomUUID();
        await transaction
          .update(pointSeasons)
          .set({ status: 'closed', closedAt: now, endsAt: now })
          .where(eq(pointSeasons.id, context.season.id));
        await transaction
          .update(walletAccounts)
          .set({ status: 'closed', updatedAt: now })
          .where(eq(walletAccounts.seasonId, context.season.id));
        await transaction.insert(pointSeasons).values({
          id: newSeasonId,
          programId: context.program.id,
          code: `reset-${now.toISOString().slice(0, 10)}-${sequence}`,
          title: `Сезон ${sequence}`,
          status: 'active',
          openingAmount: 0n,
          startsAt: now,
          activatedAt: now,
          createdBy: request.currentUser!.id,
        });
        await transaction
          .update(pointPrograms)
          .set({ activeSeasonId: newSeasonId, updatedAt: now })
          .where(eq(pointPrograms.id, context.program.id));
        await transaction.insert(walletAccounts).values([
          {
            programId: context.program.id,
            seasonId: newSeasonId,
            ownerKind: 'system_issuance',
            systemKey: walletSystemKeys.welcome,
            title: 'Стартовые начисления',
            allowNegative: true,
          },
          {
            programId: context.program.id,
            seasonId: newSeasonId,
            ownerKind: 'system_issuance',
            systemKey: walletSystemKeys.admin,
            title: 'Начисления сотрудников',
            allowNegative: true,
          },
          {
            programId: context.program.id,
            seasonId: newSeasonId,
            ownerKind: 'system_redemption',
            systemKey: walletSystemKeys.redemption,
            title: 'Списания сотрудников',
            allowNegative: false,
          },
          {
            programId: context.program.id,
            seasonId: newSeasonId,
            ownerKind: 'store',
            systemKey: walletSystemKeys.store,
            title: 'Магазин',
            allowNegative: false,
          },
        ]);
        const oldUsers = await transaction
          .select({ userId: walletAccounts.userId })
          .from(walletAccounts)
          .where(
            and(
              eq(walletAccounts.seasonId, context.season.id),
              eq(walletAccounts.ownerKind, 'user'),
              sql`${walletAccounts.userId} is not null`,
            ),
          );
        if (oldUsers.length > 0) {
          await transaction.insert(walletAccounts).values(
            oldUsers.map((account) => ({
              programId: context.program.id,
              seasonId: newSeasonId,
              ownerKind: 'user' as const,
              userId: account.userId!,
              title: 'Личный кошелёк',
              balance: 0n,
              allowNegative: false,
            })),
          );
        }
        const oldFunds = await transaction
          .select({ eventId: walletAccounts.eventId, title: walletAccounts.title })
          .from(walletAccounts)
          .where(
            and(
              eq(walletAccounts.seasonId, context.season.id),
              eq(walletAccounts.ownerKind, 'event'),
              sql`${walletAccounts.eventId} is not null`,
            ),
          );
        if (oldFunds.length > 0) {
          await transaction.insert(walletAccounts).values(
            oldFunds.map((fund) => ({
              programId: context.program.id,
              seasonId: newSeasonId,
              ownerKind: 'event' as const,
              eventId: fund.eventId!,
              systemKey: `event:${fund.eventId!}`,
              title: fund.title,
              balance: 0n,
              allowNegative: true,
            })),
          );
        }
        await transaction
          .update(walletIntents)
          .set({ status: 'expired' })
          .where(
            and(
              eq(walletIntents.seasonId, context.season.id),
              inArray(walletIntents.status, [
                'created',
                'awaiting_initiator_confirmation',
                'awaiting_owner_confirmation',
              ]),
            ),
          );
        await transaction
          .update(qrSessions)
          .set({ status: 'expired' })
          .where(
            and(
              eq(qrSessions.seasonId, context.season.id),
              inArray(qrSessions.status, ['active', 'claimed']),
            ),
          );
        const [result] = await transaction
          .update(walletResetJobs)
          .set({
            toSeasonId: newSeasonId,
            status: 'completed',
            affectedAccounts: oldUsers.length,
            completedAt: new Date(),
          })
          .where(eq(walletResetJobs.id, job.id))
          .returning();
        if (!result) throw new Error('Reset job disappeared');
        return result;
      });
      await writeAudit(request, {
        action: 'wallet.reset.complete',
        entityType: 'wallet_reset_job',
        entityId: completed.id,
        metadata: {
          fromSeasonId: completed.fromSeasonId,
          toSeasonId: completed.toSeasonId,
          affectedAccounts: completed.affectedAccounts,
          ordersPreserved: true,
        },
      });
      return {
        ...completed,
        targetOpeningAmount: serializePoints(completed.targetOpeningAmount),
        previousTotal: serializePoints(completed.previousTotal ?? 0n),
      };
    },
  );
};
