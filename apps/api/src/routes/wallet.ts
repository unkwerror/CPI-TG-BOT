import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  events,
  feedPosts,
  inventoryMovements,
  outboxEvents,
  pointFundAccess,
  qrSessions,
  storeCategories,
  storeOrderItems,
  storeOrders,
  storeProductInventory,
  storeProductMedia,
  storeProducts,
  users,
  walletAccounts,
  walletIntents,
  walletSystemKeys,
} from '@cpi/db';
import { AppError } from '@cpi/shared';
import { writeAudit } from '../audit';
import { serializeFeedCoverUrl } from '../feed-cover';
import { serializeReadyProductMediaList } from '../product-media';
import { richContentToPlainText, sanitizeRichContent, sanitizeRichHtml } from '../rich-content';
import {
  createQrSecret,
  hashQrSecret,
  pointsToBigInt,
  qrExpiry,
  requireIdempotencyKey,
  serializePoints,
  walletRequestHash,
} from '../wallet-domain';
import {
  ensureProgramSystemAccount,
  ensureUserWalletAccount,
  ensureWalletBootstrap,
  lockWalletQrMutation,
  loadActiveWalletContext,
  postLedgerTransaction,
  validateProgramAmount,
  walletHistory,
  walletProgramLockKey,
  walletSnapshot,
} from '../wallet-service';

const uuidParams = z.object({ id: z.uuid() });
const historyQuerySchema = z.object({
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const qrTokenSchema = z
  .string()
  .trim()
  .min(40)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const qrResolveSchema = z.object({ token: qrTokenSchema });
const positivePointInputSchema = z
  .union([
    z.number().int(),
    z
      .string()
      .trim()
      .regex(/^\d{1,10}$/, 'Укажите целое количество баллов'),
  ])
  .transform((value) => (typeof value === 'number' ? value : Number(value)))
  .pipe(z.number().int().positive().max(1_000_000_000));
const intentCreateSchema = z
  .object({
    token: qrTokenSchema,
    kind: z.enum(['p2p_transfer', 'staff_credit', 'staff_debit']),
    amount: positivePointInputSchema,
    reason: z.string().trim().min(3).max(500).optional(),
    eventId: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.kind !== 'p2p_transfer' && !value.reason) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Для операции сотрудника укажите причину',
      });
    }
  });
const checkoutSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(20)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (seen.has(item.productId)) {
          context.addIssue({
            code: 'custom',
            path: [index, 'productId'],
            message: 'Товар не должен повторяться',
          });
        }
        seen.add(item.productId);
      }
    }),
  comment: z.string().trim().max(2_000).optional(),
});
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

function displayName(user: {
  fullName: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
}): string {
  return (
    user.fullName ??
    ([user.telegramFirstName, user.telegramLastName].filter(Boolean).join(' ') || 'Участник')
  );
}

function serializeIntent(intent: typeof walletIntents.$inferSelect) {
  return {
    id: intent.id,
    kind: intent.kind,
    status: intent.status,
    initiatorUserId: intent.initiatorUserId,
    ownerUserId: intent.ownerUserId,
    requiredConfirmerUserId: intent.requiredConfirmerUserId,
    amount: serializePoints(intent.amount),
    reason: intent.reason,
    eventId: intent.eventId,
    transactionId: intent.transactionId,
    expiresAt: intent.expiresAt,
    createdAt: intent.createdAt,
    completedAt: intent.completedAt,
  };
}

async function resolveQr(app: Parameters<FastifyPluginAsync>[0], token: string) {
  const tokenHash = hashQrSecret(token);
  const query = app.db
    .select({ session: qrSessions, owner: users })
    .from(qrSessions)
    .innerJoin(users, eq(users.id, qrSessions.ownerUserId))
    .where(eq(qrSessions.tokenHash, tokenHash))
    .limit(1);
  const [row] = await query;
  if (!row) throw new AppError('QR_NOT_FOUND', 'QR-код не найден', 404);
  if (row.session.status !== 'active' || row.session.expiresAt <= new Date()) {
    throw new AppError('QR_EXPIRED', 'QR-код уже использован или истёк', 409);
  }
  return row;
}

async function serializedOrder(app: Parameters<FastifyPluginAsync>[0], orderId: string) {
  const [order] = await app.db
    .select()
    .from(storeOrders)
    .where(eq(storeOrders.id, orderId))
    .limit(1);
  if (!order) throw new Error('Store order disappeared');
  const items = await app.db
    .select()
    .from(storeOrderItems)
    .where(eq(storeOrderItems.orderId, order.id))
    .orderBy(asc(storeOrderItems.createdAt));
  return {
    ...order,
    totalPoints: serializePoints(order.totalPoints),
    amount: serializePoints(order.totalPoints),
    productTitle:
      items.length === 1
        ? items[0]!.titleSnapshot
        : `${items[0]?.titleSnapshot ?? 'Заказ'} и ещё ${Math.max(0, items.length - 1)}`,
    items: items.map((item) => ({
      ...item,
      productTitle: item.titleSnapshot,
      unitPrice: serializePoints(item.unitPrice),
      lineTotal: serializePoints(item.lineTotal),
      amount: serializePoints(item.lineTotal),
    })),
  };
}

export const walletRoutes: FastifyPluginAsync = async (app) => {
  const readGuards = [app.requireAuth];
  const writeGuards = [app.requireAuth, app.requireCsrf];

  app.get('/wallet', { preHandler: readGuards, schema: { tags: ['wallet'] } }, async (request) =>
    walletSnapshot(app.db, request.currentUser!.id),
  );

  app.get(
    '/wallet/history',
    { preHandler: readGuards, schema: { tags: ['wallet'] } },
    async (request) => {
      const query = historyQuerySchema.parse(request.query);
      return walletHistory(app.db, request.currentUser!.id, {
        limit: query.limit,
        ...(query.beforeId === undefined ? {} : { beforeId: query.beforeId }),
      });
    },
  );

  app.post(
    '/wallet/qr',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['wallet', 'qr'] },
    },
    async (request, reply) => {
      const { context } = await ensureWalletBootstrap(app.db, request.currentUser!.id);
      const { token, tokenHash } = createQrSecret();
      const now = new Date();
      const expiresAt = qrExpiry(now, context.program.qrTtlSeconds);
      const capabilities = [
        ...(context.program.p2pEnabled ? ['p2p_transfer'] : []),
        'staff_credit',
        'staff_debit',
      ];
      const session = await app.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock_shared(hashtextextended(${walletProgramLockKey(context.program.id)}, 0))`,
        );
        const lockedContext = await loadActiveWalletContext(
          transaction as unknown as typeof app.db,
        );
        if (
          lockedContext.program.id !== context.program.id ||
          lockedContext.season.id !== context.season.id
        ) {
          throw new AppError(
            'POINT_SEASON_CHANGED',
            'Сезон баллов обновился. Повторите операцию.',
            409,
          );
        }
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-qr:${context.program.id}:${request.currentUser!.id}`}, 0))`,
        );
        await transaction
          .update(qrSessions)
          .set({ status: 'cancelled', cancelledAt: now })
          .where(
            and(
              eq(qrSessions.ownerUserId, request.currentUser!.id),
              eq(qrSessions.purpose, 'wallet'),
              inArray(qrSessions.status, ['active', 'claimed']),
            ),
          );
        const [created] = await transaction
          .insert(qrSessions)
          .values({
            programId: context.program.id,
            seasonId: context.season.id,
            ownerUserId: request.currentUser!.id,
            purpose: 'wallet',
            capabilities,
            tokenHash,
            expiresAt,
          })
          .returning();
        if (!created) throw new Error('QR session insert returned no row');
        return created;
      });
      return reply.code(201).send({
        id: session.id,
        token,
        purpose: session.purpose,
        capabilities: session.capabilities,
        expiresAt: session.expiresAt,
      });
    },
  );

  app.post(
    '/wallet/qr/resolve',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['wallet', 'qr'] },
    },
    async (request) => {
      const body = qrResolveSchema.parse(request.body);
      const row = await resolveQr(app, body.token);
      const [fundAccess] = await app.db
        .select()
        .from(pointFundAccess)
        .where(
          and(
            eq(pointFundAccess.programId, row.session.programId),
            eq(pointFundAccess.userId, request.currentUser!.id),
            isNull(pointFundAccess.revokedAt),
          ),
        )
        .limit(1);
      const capabilities = row.session.capabilities.filter((capability) => {
        if (capability === 'staff_credit') return Boolean(fundAccess?.canCredit);
        if (capability === 'staff_debit') return Boolean(fundAccess?.canDebit);
        return capability === 'p2p_transfer';
      });
      return {
        sessionId: row.session.id,
        purpose: row.session.purpose,
        orderId: row.session.orderId,
        owner: {
          id: row.owner.id,
          displayName: displayName(row.owner),
          username: row.owner.telegramUsername,
          avatarUrl: row.owner.avatarUrl,
        },
        capabilities,
        expiresAt: row.session.expiresAt,
      };
    },
  );

  app.delete(
    '/wallet/qr/:id',
    { preHandler: writeGuards, schema: { tags: ['wallet', 'qr'] } },
    async (request, reply) => {
      const { id } = uuidParams.parse(request.params);
      await app.db.transaction(async (transaction) => {
        const [candidate] = await transaction
          .select({ id: qrSessions.id, programId: qrSessions.programId })
          .from(qrSessions)
          .where(and(eq(qrSessions.id, id), eq(qrSessions.ownerUserId, request.currentUser!.id)))
          .limit(1);
        if (!candidate) throw new AppError('QR_NOT_FOUND', 'QR-код не найден', 404);
        await lockWalletQrMutation(transaction, candidate.programId, candidate.id);
        const [intent] = await transaction
          .select({ id: walletIntents.id, status: walletIntents.status })
          .from(walletIntents)
          .where(eq(walletIntents.qrSessionId, candidate.id))
          .for('update')
          .limit(1);
        const [session] = await transaction
          .select()
          .from(qrSessions)
          .where(and(eq(qrSessions.id, id), eq(qrSessions.ownerUserId, request.currentUser!.id)))
          .for('update')
          .limit(1);
        if (!session) throw new AppError('QR_NOT_FOUND', 'QR-код не найден', 404);
        if (!['active', 'claimed'].includes(session.status)) return false;
        const now = new Date();
        await transaction
          .update(qrSessions)
          .set({ status: 'cancelled', cancelledAt: now })
          .where(eq(qrSessions.id, session.id));
        if (
          intent &&
          ['created', 'awaiting_initiator_confirmation', 'awaiting_owner_confirmation'].includes(
            intent.status,
          )
        ) {
          await transaction
            .update(walletIntents)
            .set({ status: 'cancelled', cancelledAt: now })
            .where(eq(walletIntents.id, intent.id));
        }
        return true;
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/wallet/intents',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['wallet', 'qr'] },
    },
    async (request, reply) => {
      const body = intentCreateSchema.parse(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const amount = pointsToBigInt(body.amount);
      const tokenHash = hashQrSecret(body.token);
      await ensureWalletBootstrap(app.db, request.currentUser!.id);
      const requestHash = walletRequestHash({
        kind: body.kind,
        amount,
        reason: body.reason ?? null,
        eventId: body.eventId ?? null,
        tokenHash,
      });
      const result = await app.db.transaction(async (transaction) => {
        const initialContext = await loadActiveWalletContext(
          transaction as unknown as typeof app.db,
        );
        const [qrCandidate] = await transaction
          .select({ id: qrSessions.id, programId: qrSessions.programId })
          .from(qrSessions)
          .where(eq(qrSessions.tokenHash, tokenHash))
          .limit(1);
        if (!qrCandidate) throw new AppError('QR_NOT_FOUND', 'QR-код не найден', 404);
        if (qrCandidate.programId !== initialContext.program.id) {
          throw new AppError('QR_EXPIRED', 'QR-код уже использован или истёк', 409);
        }
        await lockWalletQrMutation(transaction, initialContext.program.id, qrCandidate.id);
        const context = await loadActiveWalletContext(transaction as unknown as typeof app.db);
        if (
          context.program.id !== initialContext.program.id ||
          context.season.id !== initialContext.season.id
        ) {
          throw new AppError(
            'POINT_SEASON_CHANGED',
            'Сезон баллов обновился. Повторите операцию.',
            409,
          );
        }
        validateProgramAmount(amount, context.program);
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-intent:${request.currentUser!.id}:${idempotencyKey}`}, 0))`,
        );
        const [existing] = await transaction
          .select()
          .from(walletIntents)
          .where(
            and(
              eq(walletIntents.initiatorUserId, request.currentUser!.id),
              eq(walletIntents.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              'Этот Idempotency-Key уже использован для другого перевода',
              409,
            );
          }
          return { intent: existing, replayed: true };
        }
        const [qr] = await transaction
          .select()
          .from(qrSessions)
          .where(and(eq(qrSessions.id, qrCandidate.id), eq(qrSessions.tokenHash, tokenHash)))
          .for('update')
          .limit(1);
        if (!qr) throw new AppError('QR_NOT_FOUND', 'QR-код не найден', 404);
        if (
          qr.purpose !== 'wallet' ||
          qr.status !== 'active' ||
          qr.expiresAt <= new Date() ||
          qr.programId !== context.program.id ||
          qr.seasonId !== context.season.id
        ) {
          throw new AppError('QR_EXPIRED', 'QR-код уже использован или истёк', 409);
        }
        if (qr.ownerUserId === request.currentUser!.id) {
          throw new AppError('SELF_TRANSFER_FORBIDDEN', 'Нельзя провести операцию с собой', 409);
        }
        const initiatorAccount = await ensureUserWalletAccount(
          transaction,
          context,
          request.currentUser!.id,
        );
        const ownerAccount = await ensureUserWalletAccount(transaction, context, qr.ownerUserId);
        let payerAccountId: string;
        let payeeAccountId: string;
        let requiredConfirmerUserId: string;
        let status: 'awaiting_initiator_confirmation' | 'awaiting_owner_confirmation';
        if (body.kind === 'p2p_transfer') {
          if (!context.program.p2pEnabled) {
            throw new AppError('P2P_DISABLED', 'Переводы между участниками отключены', 409);
          }
          if (initiatorAccount.balance < amount) {
            throw new AppError('INSUFFICIENT_POINTS', 'Недостаточно баллов', 409);
          }
          payerAccountId = initiatorAccount.id;
          payeeAccountId = ownerAccount.id;
          requiredConfirmerUserId = request.currentUser!.id;
          status = 'awaiting_initiator_confirmation';
        } else {
          const [access] = await transaction
            .select()
            .from(pointFundAccess)
            .where(
              and(
                eq(pointFundAccess.programId, context.program.id),
                eq(pointFundAccess.userId, request.currentUser!.id),
                isNull(pointFundAccess.revokedAt),
              ),
            )
            .limit(1);
          const allowed = body.kind === 'staff_credit' ? access?.canCredit : access?.canDebit;
          if (!allowed) {
            throw new AppError('FUND_ACCESS_REQUIRED', 'Нет доступа к фонду мероприятия', 403);
          }
          if (body.kind === 'staff_credit') {
            const treasury = await ensureProgramSystemAccount(
              transaction,
              context,
              walletSystemKeys.admin,
            );
            payerAccountId = treasury.id;
            payeeAccountId = ownerAccount.id;
            requiredConfirmerUserId = request.currentUser!.id;
            status = 'awaiting_initiator_confirmation';
          } else {
            const redemption = await ensureProgramSystemAccount(
              transaction,
              context,
              walletSystemKeys.redemption,
            );
            payerAccountId = ownerAccount.id;
            payeeAccountId = redemption.id;
            requiredConfirmerUserId = qr.ownerUserId;
            status = 'awaiting_owner_confirmation';
          }
        }
        const [intent] = await transaction
          .insert(walletIntents)
          .values({
            programId: context.program.id,
            seasonId: context.season.id,
            qrSessionId: qr.id,
            kind: body.kind,
            status,
            initiatorUserId: request.currentUser!.id,
            ownerUserId: qr.ownerUserId,
            payerAccountId,
            payeeAccountId,
            requiredConfirmerUserId,
            amount,
            reason: body.reason ?? null,
            eventId: body.eventId ?? null,
            idempotencyKey,
            requestHash,
            expiresAt: new Date(Date.now() + context.program.intentTtlSeconds * 1_000),
          })
          .returning();
        if (!intent) throw new Error('Wallet intent insert returned no row');
        await transaction
          .update(qrSessions)
          .set({
            status: 'claimed',
            claimedByUserId: request.currentUser!.id,
            claimedAt: new Date(),
          })
          .where(eq(qrSessions.id, qr.id));
        await transaction
          .insert(outboxEvents)
          .values({
            type: 'wallet.intent.created',
            aggregateType: 'wallet_intent',
            aggregateId: intent.id,
            payload: {
              intentId: intent.id,
              ownerUserId: intent.ownerUserId,
              requiredConfirmerUserId,
              kind: intent.kind,
            },
          })
          .onConflictDoNothing();
        return { intent, replayed: false };
      });
      if (body.kind.startsWith('staff_') && !result.replayed) {
        await writeAudit(request, {
          action: 'wallet.staff_intent.create',
          entityType: 'wallet_intent',
          entityId: result.intent.id,
          ...(result.intent.eventId ? { eventId: result.intent.eventId } : {}),
          metadata: { kind: body.kind, amount: serializePoints(amount) },
        });
      }
      return reply.code(result.replayed ? 200 : 201).send(serializeIntent(result.intent));
    },
  );

  app.get(
    '/wallet/intents/pending',
    { preHandler: readGuards, schema: { tags: ['wallet'] } },
    async (request) => {
      const rows = await app.db
        .select()
        .from(walletIntents)
        .where(
          and(
            or(
              eq(walletIntents.initiatorUserId, request.currentUser!.id),
              eq(walletIntents.ownerUserId, request.currentUser!.id),
              eq(walletIntents.requiredConfirmerUserId, request.currentUser!.id),
            ),
            inArray(walletIntents.status, [
              'awaiting_initiator_confirmation',
              'awaiting_owner_confirmation',
            ]),
          ),
        )
        .orderBy(desc(walletIntents.createdAt))
        .limit(100);
      const participantIds = [
        ...new Set(rows.flatMap((intent) => [intent.initiatorUserId, intent.ownerUserId])),
      ];
      const participants =
        participantIds.length === 0
          ? []
          : await app.db.select().from(users).where(inArray(users.id, participantIds));
      const publicUsers = new Map(
        participants.map((user) => [
          user.id,
          {
            id: user.id,
            displayName: displayName(user),
            username: user.telegramUsername,
            avatarUrl: user.avatarUrl,
          },
        ]),
      );
      return {
        items: rows.map((intent) => ({
          ...serializeIntent(intent),
          initiator: publicUsers.get(intent.initiatorUserId) ?? null,
          owner: publicUsers.get(intent.ownerUserId) ?? null,
        })),
      };
    },
  );

  app.post(
    '/wallet/intents/:id/confirm',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['wallet'] },
    },
    async (request) => {
      const { id } = uuidParams.parse(request.params);
      const result = await app.db.transaction(async (transaction) => {
        const [candidate] = await transaction
          .select({
            programId: walletIntents.programId,
            qrSessionId: walletIntents.qrSessionId,
          })
          .from(walletIntents)
          .where(eq(walletIntents.id, id))
          .limit(1);
        if (!candidate) {
          throw new AppError('WALLET_INTENT_NOT_FOUND', 'Операция не найдена', 404);
        }
        await lockWalletQrMutation(transaction, candidate.programId, candidate.qrSessionId);
        const [intent] = await transaction
          .select()
          .from(walletIntents)
          .where(eq(walletIntents.id, id))
          .for('update')
          .limit(1);
        if (!intent) throw new AppError('WALLET_INTENT_NOT_FOUND', 'Операция не найдена', 404);
        if (
          intent.initiatorUserId !== request.currentUser!.id &&
          intent.ownerUserId !== request.currentUser!.id
        ) {
          throw new AppError('WALLET_INTENT_FORBIDDEN', 'Нет доступа к операции', 403);
        }
        if (intent.status === 'completed') return { intent, expired: false as const };
        const context = await loadActiveWalletContext(transaction as unknown as typeof app.db);
        if (intent.programId !== context.program.id || intent.seasonId !== context.season.id) {
          await transaction
            .update(walletIntents)
            .set({ status: 'expired' })
            .where(eq(walletIntents.id, intent.id));
          await transaction
            .update(qrSessions)
            .set({ status: 'expired' })
            .where(eq(qrSessions.id, intent.qrSessionId));
          return { intent: null, expired: true as const };
        }
        if (intent.expiresAt <= new Date()) {
          await transaction
            .update(walletIntents)
            .set({ status: 'expired' })
            .where(eq(walletIntents.id, intent.id));
          await transaction
            .update(qrSessions)
            .set({ status: 'expired' })
            .where(eq(qrSessions.id, intent.qrSessionId));
          return { intent: null, expired: true as const };
        }
        if (
          !['awaiting_initiator_confirmation', 'awaiting_owner_confirmation'].includes(
            intent.status,
          ) ||
          intent.requiredConfirmerUserId !== request.currentUser!.id
        ) {
          throw new AppError(
            'WALLET_CONFIRMATION_FORBIDDEN',
            'Эту операцию должен подтвердить другой участник',
            403,
          );
        }
        validateProgramAmount(intent.amount, context.program);
        const posted = await postLedgerTransaction(transaction, context, {
          kind: intent.kind,
          idempotencyKey: `intent:${intent.id}`,
          requestHash: walletRequestHash({
            intentId: intent.id,
            payerAccountId: intent.payerAccountId,
            payeeAccountId: intent.payeeAccountId,
            amount: intent.amount,
          }),
          actorUserId: request.currentUser!.id,
          subjectUserId: intent.ownerUserId,
          eventId: intent.eventId,
          reason: intent.reason,
          metadata: { walletIntentId: intent.id },
          entries: [
            { accountId: intent.payerAccountId, delta: -intent.amount },
            { accountId: intent.payeeAccountId, delta: intent.amount },
          ],
        });
        const now = new Date();
        const [completed] = await transaction
          .update(walletIntents)
          .set({
            status: 'completed',
            transactionId: posted.transactionId,
            confirmedAt: now,
            completedAt: now,
          })
          .where(eq(walletIntents.id, intent.id))
          .returning();
        await transaction
          .update(qrSessions)
          .set({ status: 'consumed', consumedAt: now })
          .where(eq(qrSessions.id, intent.qrSessionId));
        if (!completed) throw new Error('Wallet intent disappeared during confirmation');
        return { intent: completed, expired: false as const };
      });
      if (result.expired || !result.intent) {
        throw new AppError('WALLET_INTENT_EXPIRED', 'Время подтверждения истекло', 409);
      }
      if (result.intent.kind.startsWith('staff_')) {
        await writeAudit(request, {
          action: 'wallet.staff_intent.complete',
          entityType: 'wallet_intent',
          entityId: result.intent.id,
          ...(result.intent.eventId ? { eventId: result.intent.eventId } : {}),
          metadata: {
            kind: result.intent.kind,
            amount: serializePoints(result.intent.amount),
          },
        });
      }
      return serializeIntent(result.intent);
    },
  );

  app.post(
    '/wallet/intents/:id/reject',
    { preHandler: writeGuards, schema: { tags: ['wallet'] } },
    async (request) => {
      const { id } = uuidParams.parse(request.params);
      const [rejected] = await app.db.transaction(async (transaction) => {
        const [candidate] = await transaction
          .select({
            programId: walletIntents.programId,
            qrSessionId: walletIntents.qrSessionId,
          })
          .from(walletIntents)
          .where(eq(walletIntents.id, id))
          .limit(1);
        if (!candidate) {
          throw new AppError('WALLET_INTENT_NOT_FOUND', 'Операция не найдена', 404);
        }
        await lockWalletQrMutation(transaction, candidate.programId, candidate.qrSessionId);
        const [intent] = await transaction
          .select()
          .from(walletIntents)
          .where(eq(walletIntents.id, id))
          .for('update')
          .limit(1);
        if (!intent) {
          throw new AppError('WALLET_INTENT_NOT_FOUND', 'Операция не найдена', 404);
        }
        if (
          intent.requiredConfirmerUserId !== request.currentUser!.id &&
          intent.initiatorUserId !== request.currentUser!.id
        ) {
          throw new AppError('WALLET_INTENT_FORBIDDEN', 'Нет доступа к операции', 403);
        }
        if (
          !['awaiting_initiator_confirmation', 'awaiting_owner_confirmation'].includes(
            intent.status,
          )
        ) {
          throw new AppError('WALLET_INTENT_FINAL', 'Операция уже завершена', 409);
        }
        const now = new Date();
        const updated = await transaction
          .update(walletIntents)
          .set({ status: 'rejected', rejectedAt: now })
          .where(
            and(
              eq(walletIntents.id, intent.id),
              inArray(walletIntents.status, [
                'awaiting_initiator_confirmation',
                'awaiting_owner_confirmation',
              ]),
            ),
          )
          .returning();
        if (updated.length > 0) {
          const restoreQr =
            intent.status === 'awaiting_initiator_confirmation' &&
            request.currentUser!.id === intent.initiatorUserId;
          if (restoreQr) {
            await transaction
              .update(qrSessions)
              .set({
                status: 'active',
                claimedByUserId: null,
                claimedAt: null,
              })
              .where(and(eq(qrSessions.id, intent.qrSessionId), eq(qrSessions.status, 'claimed')));
          } else {
            await transaction
              .update(qrSessions)
              .set({ status: 'cancelled', cancelledAt: now })
              .where(eq(qrSessions.id, intent.qrSessionId));
          }
        }
        return updated;
      });
      if (!rejected) throw new AppError('WALLET_INTENT_FINAL', 'Операция уже завершена', 409);
      return serializeIntent(rejected);
    },
  );

  app.get(
    '/wallet/funds',
    { preHandler: readGuards, schema: { tags: ['wallet'] } },
    async (request) => {
      const { context } = await ensureWalletBootstrap(app.db, request.currentUser!.id);
      const [access] = await app.db
        .select()
        .from(pointFundAccess)
        .where(
          and(
            eq(pointFundAccess.programId, context.program.id),
            eq(pointFundAccess.userId, request.currentUser!.id),
            isNull(pointFundAccess.revokedAt),
          ),
        )
        .limit(1);
      if (!access?.canView && !access?.canCredit && !access?.canDebit)
        return { access: null, items: [] };
      const funds = await app.db
        .select({ account: walletAccounts, event: events })
        .from(walletAccounts)
        .innerJoin(events, eq(events.id, walletAccounts.eventId))
        .where(
          and(
            eq(walletAccounts.programId, context.program.id),
            eq(walletAccounts.seasonId, context.season.id),
            eq(walletAccounts.ownerKind, 'event'),
            eq(walletAccounts.status, 'active'),
            isNull(events.deletedAt),
          ),
        )
        .orderBy(asc(events.startsAt));
      return {
        access: {
          canView: access.canView,
          canCredit: access.canCredit,
          canDebit: access.canDebit,
        },
        items: funds.map(({ account, event }) => ({
          id: account.id,
          eventId: event.id,
          title: event.title,
          balance: access.canView ? serializePoints(account.balance) : null,
        })),
      };
    },
  );

  app.get('/store/products', { preHandler: readGuards, schema: { tags: ['store'] } }, async () => {
    const now = new Date();
    const products = await app.db
      .select({
        product: storeProducts,
        inventory: storeProductInventory,
        category: storeCategories,
      })
      .from(storeProducts)
      .leftJoin(storeProductInventory, eq(storeProductInventory.productId, storeProducts.id))
      .leftJoin(storeCategories, eq(storeCategories.id, storeProducts.categoryId))
      .where(
        and(
          eq(storeProducts.status, 'published'),
          isNull(storeProducts.deletedAt),
          or(isNull(storeProducts.availableFrom), lte(storeProducts.availableFrom, now)),
          or(isNull(storeProducts.availableUntil), sql`${storeProducts.availableUntil} >= ${now}`),
        ),
      )
      .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.title));
    const ids = products.map(({ product }) => product.id);
    const media =
      ids.length === 0
        ? []
        : await serializeReadyProductMediaList(
            app.s3,
            app.config,
            await app.db
              .select()
              .from(storeProductMedia)
              .where(inArray(storeProductMedia.productId, ids))
              .orderBy(asc(storeProductMedia.sortOrder)),
          );
    return {
      items: products.map(({ product, inventory, category }) => {
        const productMedia = media.filter((item) => item.productId === product.id);
        return {
          ...product,
          cardPackageId: null,
          description: product.description
            ? sanitizeRichContent(product.description, product.descriptionFormat)
            : null,
          cardHtml: product.cardHtml ? sanitizeRichHtml(product.cardHtml) : null,
          price: serializePoints(product.price),
          category: category
            ? { id: category.id, slug: category.slug, title: category.title }
            : null,
          available:
            product.stockMode === 'unlimited'
              ? null
              : Math.max(0, (inventory?.onHand ?? 0) - (inventory?.reserved ?? 0)),
          coverUrl: product.coverUrl ?? productMedia[0]?.url ?? null,
          media: productMedia,
        };
      }),
    };
  });

  app.post(
    '/store/checkout',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['store'] },
    },
    async (request, reply) => {
      const body = checkoutSchema.parse(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const normalizedItems = [...body.items].sort((left, right) =>
        left.productId.localeCompare(right.productId),
      );
      const requestHash = walletRequestHash({
        items: normalizedItems,
        comment: body.comment ?? null,
      });
      await ensureWalletBootstrap(app.db, request.currentUser!.id);
      const result = await app.db.transaction(async (transaction) => {
        const context = await loadActiveWalletContext(transaction as unknown as typeof app.db);
        if (!context.program.storeEnabled) {
          throw new AppError('STORE_DISABLED', 'Магазин временно закрыт', 409);
        }
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`store-checkout:${request.currentUser!.id}:${idempotencyKey}`}, 0))`,
        );
        const [existing] = await transaction
          .select()
          .from(storeOrders)
          .where(
            and(
              eq(storeOrders.userId, request.currentUser!.id),
              eq(storeOrders.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              'Этот Idempotency-Key уже использован для другой покупки',
              409,
            );
          }
          return { orderId: existing.id, replayed: true };
        }
        const ids = normalizedItems.map((item) => item.productId);
        const lockedProducts = await transaction
          .select()
          .from(storeProducts)
          .where(inArray(storeProducts.id, ids))
          .orderBy(asc(storeProducts.id))
          .for('update');
        if (lockedProducts.length !== ids.length) {
          throw new AppError('PRODUCT_NOT_FOUND', 'Один из товаров не найден', 404);
        }
        const inventoryRows = await transaction
          .select()
          .from(storeProductInventory)
          .where(inArray(storeProductInventory.productId, ids))
          .orderBy(asc(storeProductInventory.productId))
          .for('update');
        const inventoryByProduct = new Map(
          inventoryRows.map((inventory) => [inventory.productId, inventory]),
        );
        const productRows = lockedProducts.map((product) => ({
          product,
          inventory: inventoryByProduct.get(product.id) ?? null,
        }));
        const now = new Date();
        const requestedById = new Map(normalizedItems.map((item) => [item.productId, item]));
        let total = 0n;
        for (const row of productRows) {
          const requested = requestedById.get(row.product.id)!;
          if (
            row.product.status !== 'published' ||
            row.product.deletedAt ||
            (row.product.availableFrom && row.product.availableFrom > now) ||
            (row.product.availableUntil && row.product.availableUntil < now)
          ) {
            throw new AppError(
              'PRODUCT_UNAVAILABLE',
              `Товар «${row.product.title}» недоступен`,
              409,
            );
          }
          if (row.product.stockMode === 'limited') {
            const available = (row.inventory?.onHand ?? 0) - (row.inventory?.reserved ?? 0);
            if (!row.inventory || available < requested.quantity) {
              throw new AppError(
                'PRODUCT_OUT_OF_STOCK',
                `Недостаточно товара «${row.product.title}»`,
                409,
              );
            }
          }
          if (row.product.perUserLimit) {
            const [previous] = await transaction
              .select({ quantity: sql<number>`coalesce(sum(${storeOrderItems.quantity}), 0)::int` })
              .from(storeOrderItems)
              .innerJoin(storeOrders, eq(storeOrders.id, storeOrderItems.orderId))
              .where(
                and(
                  eq(storeOrders.userId, request.currentUser!.id),
                  eq(storeOrderItems.productId, row.product.id),
                ),
              );
            if ((previous?.quantity ?? 0) + requested.quantity > row.product.perUserLimit) {
              throw new AppError(
                'PRODUCT_USER_LIMIT',
                `Превышен лимит на товар «${row.product.title}»`,
                409,
              );
            }
          }
          total += row.product.price * BigInt(requested.quantity);
        }
        validateProgramAmount(total, context.program);
        const userAccount = await ensureUserWalletAccount(
          transaction,
          context,
          request.currentUser!.id,
        );
        const storeAccount = await ensureProgramSystemAccount(
          transaction,
          context,
          walletSystemKeys.store,
        );
        const orderId = randomUUID();
        const payment = await postLedgerTransaction(transaction, context, {
          kind: 'store_purchase',
          idempotencyKey: `store:${request.currentUser!.id}:${idempotencyKey}`,
          requestHash,
          actorUserId: request.currentUser!.id,
          subjectUserId: request.currentUser!.id,
          relatedOrderId: orderId,
          reason: 'Покупка в магазине',
          metadata: { orderId, itemCount: normalizedItems.length },
          entries: [
            { accountId: userAccount.id, delta: -total },
            { accountId: storeAccount.id, delta: total },
          ],
        });
        const firstProduct = productRows[0]!.product;
        await transaction.insert(storeOrders).values({
          id: orderId,
          programId: context.program.id,
          seasonId: context.season.id,
          userId: request.currentUser!.id,
          status: 'paid',
          totalPoints: total,
          paymentTransactionId: payment.transactionId,
          idempotencyKey,
          requestHash,
          comment: body.comment ?? null,
          pickupInstructionsSnapshot:
            productRows.length === 1 ? firstProduct.pickupInstructions : null,
        });
        for (const row of productRows) {
          const requested = requestedById.get(row.product.id)!;
          await transaction.insert(storeOrderItems).values({
            orderId,
            productId: row.product.id,
            titleSnapshot: row.product.title,
            unitPrice: row.product.price,
            quantity: requested.quantity,
            lineTotal: row.product.price * BigInt(requested.quantity),
          });
          if (row.product.stockMode === 'limited') {
            const nextReserved = row.inventory!.reserved + requested.quantity;
            await transaction
              .update(storeProductInventory)
              .set({
                reserved: nextReserved,
                version: sql`${storeProductInventory.version} + 1`,
                updatedAt: now,
              })
              .where(eq(storeProductInventory.productId, row.product.id));
            await transaction.insert(inventoryMovements).values({
              productId: row.product.id,
              orderId,
              kind: 'reserve',
              quantity: requested.quantity,
              onHandAfter: row.inventory!.onHand,
              reservedAfter: nextReserved,
              idempotencyKey: `checkout:${orderId}:${row.product.id}`,
              reason: 'Резерв при покупке',
              actorUserId: request.currentUser!.id,
            });
          }
        }
        await transaction
          .insert(outboxEvents)
          .values({
            type: 'store.order.paid',
            aggregateType: 'store_order',
            aggregateId: orderId,
            payload: { orderId, userId: request.currentUser!.id },
          })
          .onConflictDoNothing();
        return { orderId, replayed: false };
      });
      const order = await serializedOrder(app, result.orderId);
      return reply.code(result.replayed ? 200 : 201).send(order);
    },
  );

  app.post(
    '/store/orders/:id/pickup-request',
    { preHandler: writeGuards, schema: { tags: ['store'] } },
    async (request) => {
      const { id } = uuidParams.parse(request.params);
      await app.db.transaction(async (transaction) => {
        const [order] = await transaction
          .select()
          .from(storeOrders)
          .where(and(eq(storeOrders.id, id), eq(storeOrders.userId, request.currentUser!.id)))
          .for('update')
          .limit(1);
        if (!order) throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', 404);
        if (order.status === 'pickup_requested') return;
        if (order.status !== 'paid') {
          throw new AppError('ORDER_STATE_INVALID', 'Заказ уже передан в выдачу', 409);
        }
        await transaction
          .update(storeOrders)
          .set({ status: 'pickup_requested' })
          .where(eq(storeOrders.id, order.id));
        await transaction
          .insert(outboxEvents)
          .values({
            type: 'store.order.pickup_requested',
            aggregateType: 'store_order',
            aggregateId: order.id,
            payload: { orderId: order.id, userId: order.userId },
          })
          .onConflictDoNothing();
      });
      return serializedOrder(app, id);
    },
  );

  app.get(
    '/store/orders',
    { preHandler: readGuards, schema: { tags: ['store'] } },
    async (request) => {
      const orders = await app.db
        .select({ id: storeOrders.id })
        .from(storeOrders)
        .where(eq(storeOrders.userId, request.currentUser!.id))
        .orderBy(desc(storeOrders.createdAt))
        .limit(100);
      return { items: await Promise.all(orders.map((order) => serializedOrder(app, order.id))) };
    },
  );

  app.post(
    '/store/orders/:id/qr',
    { preHandler: writeGuards, schema: { tags: ['store', 'qr'] } },
    async (request, reply) => {
      const { id } = uuidParams.parse(request.params);
      const [order] = await app.db
        .select()
        .from(storeOrders)
        .where(and(eq(storeOrders.id, id), eq(storeOrders.userId, request.currentUser!.id)))
        .limit(1);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', 404);
      if (!['pickup_requested', 'ready_for_pickup'].includes(order.status)) {
        throw new AppError('ORDER_NOT_PICKABLE', 'Заказ ещё нельзя выдать', 409);
      }
      const { context } = await ensureWalletBootstrap(app.db, request.currentUser!.id);
      const { token, tokenHash } = createQrSecret();
      const expiresAt = qrExpiry(new Date(), context.program.qrTtlSeconds);
      const [session] = await app.db
        .insert(qrSessions)
        .values({
          programId: context.program.id,
          seasonId: context.season.id,
          ownerUserId: request.currentUser!.id,
          purpose: 'order_pickup',
          capabilities: ['order_pickup'],
          tokenHash,
          orderId: order.id,
          expiresAt,
        })
        .returning();
      if (!session) throw new Error('Order QR insert returned no row');
      return reply.code(201).send({
        id: session.id,
        token,
        purpose: session.purpose,
        orderId: order.id,
        expiresAt,
      });
    },
  );

  app.get('/feed', { preHandler: readGuards, schema: { tags: ['feed'] } }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const audiences: Array<'all' | 'participants' | 'admins'> = ['all', 'participants'];
    if (request.currentUser!.roles.some((role) => role === 'admin' || role === 'superadmin')) {
      audiences.push('admins');
    }
    const now = new Date();
    const [posts, eventRows, productRows, history] = await Promise.all([
      app.db
        .select()
        .from(feedPosts)
        .where(
          and(
            eq(feedPosts.status, 'published'),
            inArray(feedPosts.audience, audiences),
            or(isNull(feedPosts.publishedAt), lte(feedPosts.publishedAt, now)),
          ),
        )
        .orderBy(desc(feedPosts.pinned), desc(feedPosts.publishedAt), desc(feedPosts.createdAt))
        .limit(query.limit),
      app.db
        .select()
        .from(events)
        .where(
          and(
            inArray(events.status, ['published', 'running']),
            isNull(events.deletedAt),
            sql`${events.endsAt} >= ${now}`,
          ),
        )
        .orderBy(asc(events.startsAt))
        .limit(10),
      app.db
        .select()
        .from(storeProducts)
        .where(and(eq(storeProducts.status, 'published'), isNull(storeProducts.deletedAt)))
        .orderBy(desc(storeProducts.createdAt))
        .limit(10),
      walletHistory(app.db, request.currentUser!.id, { limit: 10 }),
    ]);
    const feedItems = await Promise.all(
      posts.map(async (post) => ({
        id: post.id,
        source: 'post' as const,
        kind: post.kind,
        title: post.title,
        summary: post.summary,
        body: sanitizeRichContent(post.body, post.bodyFormat),
        bodyFormat: post.bodyFormat,
        cardHtml: post.cardHtml ? sanitizeRichHtml(post.cardHtml) : null,
        cardPackageId: null,
        imageUrl: await serializeFeedCoverUrl(app.s3, app.config, post),
        actionLabel: post.ctaLabel,
        actionUrl: post.ctaUrl,
        eventId: post.eventId,
        productId: post.productId,
        pinned: post.pinned,
        publishedAt: post.publishedAt ?? post.createdAt,
      })),
    );
    const items = [
      ...feedItems,
      ...eventRows.map((event) => ({
        id: `event:${event.id}`,
        source: 'event' as const,
        kind: 'event' as const,
        title: event.title,
        summary: event.description
          ? richContentToPlainText(event.description, event.descriptionFormat).slice(0, 240)
          : null,
        body: event.description
          ? sanitizeRichContent(event.description, event.descriptionFormat)
          : '',
        bodyFormat: event.descriptionFormat,
        cardHtml: event.cardHtml ? sanitizeRichHtml(event.cardHtml) : null,
        cardPackageId: null,
        imageUrl: event.coverUrl,
        actionLabel: 'Открыть мероприятие',
        actionUrl: `/events/${event.slug}`,
        eventId: event.id,
        productId: null,
        pinned: false,
        publishedAt: event.updatedAt,
      })),
      ...productRows.map((product) => ({
        id: `product:${product.id}`,
        source: 'product' as const,
        kind: 'product' as const,
        title: product.title,
        summary: product.description
          ? richContentToPlainText(product.description, product.descriptionFormat).slice(0, 240)
          : null,
        body: product.description
          ? sanitizeRichContent(product.description, product.descriptionFormat)
          : '',
        bodyFormat: product.descriptionFormat,
        cardHtml: product.cardHtml ? sanitizeRichHtml(product.cardHtml) : null,
        cardPackageId: null,
        imageUrl: product.coverUrl,
        actionLabel: `Купить за ${serializePoints(product.price)}`,
        actionUrl: `/store?product=${product.id}`,
        eventId: null,
        productId: product.id,
        pinned: false,
        publishedAt: product.updatedAt,
      })),
      ...history.items.map((entry) => ({
        id: `transaction:${entry.transactionId}`,
        source: 'personal' as const,
        kind: 'system' as const,
        title: BigInt(entry.delta) > 0n ? `+${entry.delta} баллов` : `${entry.delta} баллов`,
        summary: entry.reason,
        body: entry.reason ?? 'Операция с баллами',
        bodyFormat: 'text' as const,
        cardHtml: null,
        cardPackageId: null,
        imageUrl: null,
        actionLabel: 'Открыть историю',
        actionUrl: '/history',
        eventId: entry.eventId,
        productId: null,
        pinned: false,
        publishedAt: entry.createdAt,
      })),
    ]
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();
      })
      .slice(0, query.limit);
    return { items };
  });
};
