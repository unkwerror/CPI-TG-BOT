import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  isCrmReadyFullName,
  maxAuthSchema,
  telegramAuthSchema,
  type AuthResponse,
} from '@cpi/shared';
import { outboxEvents, userMessengerIdentities, users } from '@cpi/db';
import { createSession, destroySession, ensureUserRole, loadAuthenticatedUser } from '../auth';
import { verifyTelegramInitData } from '../telegram-auth';
import { verifyMaxInitData } from '../max-auth';
import type { SessionData } from '../types';
import { ensureWalletBootstrap } from '../wallet-service';

function authPayload(
  user: NonNullable<Awaited<ReturnType<typeof loadAuthenticatedUser>>>,
  session: SessionData,
): AuthResponse {
  return {
    user: {
      id: user.id,
      telegramUserId: user.telegramUserId?.toString() ?? null,
      messengerProvider: session.messengerProvider ?? 'telegram',
      messengerUserId: session.messengerUserId ?? user.telegramUserId?.toString() ?? user.id,
      fullName: user.fullName,
      roles: user.roles,
      profileComplete: Boolean(isCrmReadyFullName(user.fullName) && user.consentAt),
    },
    csrfToken: session.csrfToken,
    sessionToken: session.id,
  };
}

interface MessengerIdentityProfile {
  externalUserId: string;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  avatarUrl: string | null;
}

async function upsertMessengerIdentity(
  database: Parameters<FastifyPluginAsync>[0]['db'],
  userId: string,
  provider: 'telegram' | 'max',
  profile: MessengerIdentityProfile,
  now: Date,
): Promise<void> {
  await database
    .insert(userMessengerIdentities)
    .values({
      userId,
      provider,
      externalUserId: profile.externalUserId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      languageCode: profile.languageCode,
      avatarUrl: profile.avatarUrl,
      canMessage: true,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userMessengerIdentities.provider, userMessengerIdentities.externalUserId],
      set: {
        username: profile.username,
        firstName: profile.firstName,
        lastName: profile.lastName,
        languageCode: profile.languageCode,
        avatarUrl: profile.avatarUrl,
        canMessage: true,
        lastSeenAt: now,
        updatedAt: now,
      },
    });
}

async function findMaxUser(
  database: Parameters<FastifyPluginAsync>[0]['db'],
  externalUserId: string,
) {
  const [row] = await database
    .select({ user: users })
    .from(userMessengerIdentities)
    .innerJoin(users, eq(users.id, userMessengerIdentities.userId))
    .where(
      and(
        eq(userMessengerIdentities.provider, 'max'),
        eq(userMessengerIdentities.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return row?.user ?? null;
}

async function enqueueCrmUserSync(
  database: Parameters<FastifyPluginAsync>[0]['db'],
  userId: string,
  now: Date,
): Promise<void> {
  await database
    .insert(outboxEvents)
    .values({
      type: 'crm.user.sync',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { userId },
    })
    .onConflictDoUpdate({
      target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
      set: {
        processedAt: null,
        availableAt: now,
        attempts: 0,
        lastError: null,
      },
    });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/auth/telegram',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Проверить Telegram Mini App initData и создать серверную сессию',
      },
    },
    async (request, reply) => {
      const body = telegramAuthSchema.parse(request.body);
      const telegram = verifyTelegramInitData(body.initData, app.config.TELEGRAM_BOT_TOKEN, {
        maxAgeSeconds: app.config.TELEGRAM_AUTH_MAX_AGE_SECONDS,
      });
      const now = new Date();
      const [databaseUser] = await app.db
        .insert(users)
        .values({
          telegramUserId: telegram.user.id,
          telegramUsername: telegram.user.username ?? null,
          telegramFirstName: telegram.user.firstName,
          telegramLastName: telegram.user.lastName ?? null,
          telegramLanguageCode: telegram.user.languageCode ?? null,
          avatarUrl: telegram.user.photoUrl ?? null,
          fullName: null,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: {
            telegramUsername: telegram.user.username ?? null,
            telegramFirstName: telegram.user.firstName,
            telegramLastName: telegram.user.lastName ?? null,
            telegramLanguageCode: telegram.user.languageCode ?? null,
            avatarUrl: telegram.user.photoUrl ?? null,
            lastSeenAt: now,
          },
        })
        .returning();
      if (!databaseUser) throw new Error('User upsert returned no row');

      await upsertMessengerIdentity(
        app.db,
        databaseUser.id,
        'telegram',
        {
          externalUserId: telegram.user.id.toString(),
          username: telegram.user.username ?? null,
          firstName: telegram.user.firstName,
          lastName: telegram.user.lastName ?? null,
          languageCode: telegram.user.languageCode ?? null,
          avatarUrl: telegram.user.photoUrl ?? null,
        },
        now,
      );

      await ensureUserRole(app.db, databaseUser.id, 'participant');
      if (app.config.SUPERADMIN_TELEGRAM_IDS.includes(telegram.user.id.toString())) {
        await ensureUserRole(app.db, databaseUser.id, 'superadmin');
      }
      await ensureWalletBootstrap(app.db, databaseUser.id);
      await enqueueCrmUserSync(app.db, databaseUser.id, now);
      const session = await createSession(app, reply, databaseUser.id, {
        provider: 'telegram',
        externalUserId: telegram.user.id.toString(),
      });
      const authenticated = await loadAuthenticatedUser(app.db, databaseUser.id);
      if (!authenticated) throw new Error('Authenticated user disappeared');
      return authPayload(authenticated, session);
    },
  );

  app.post(
    '/auth/max',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Проверить MAX Mini App initData и создать общую сессию',
      },
    },
    async (request, reply) => {
      if (!app.config.MAX_BOT_TOKEN) {
        return reply.code(503).send({
          error: {
            code: 'MAX_NOT_CONFIGURED',
            message: 'Вход через MAX пока не настроен',
          },
        });
      }
      const body = maxAuthSchema.parse(request.body);
      const max = verifyMaxInitData(body.initData, app.config.MAX_BOT_TOKEN, {
        maxAgeSeconds: app.config.MAX_AUTH_MAX_AGE_SECONDS,
      });
      const now = new Date();
      const externalUserId = max.user.id.toString();
      let databaseUser = await findMaxUser(app.db, externalUserId);
      if (!databaseUser) {
        try {
          databaseUser = await app.db.transaction(async (transaction) => {
            const [existingRow] = await transaction
              .select({ user: users })
              .from(userMessengerIdentities)
              .innerJoin(users, eq(users.id, userMessengerIdentities.userId))
              .where(
                and(
                  eq(userMessengerIdentities.provider, 'max'),
                  eq(userMessengerIdentities.externalUserId, externalUserId),
                ),
              )
              .limit(1);
            const existing = existingRow?.user ?? null;
            if (existing) return existing;
            const [created] = await transaction
              .insert(users)
              .values({
                telegramUserId: null,
                avatarUrl: max.user.photoUrl ?? null,
                fullName: null,
                lastSeenAt: now,
              })
              .returning();
            if (!created) throw new Error('MAX user insert returned no row');
            const [identity] = await transaction
              .insert(userMessengerIdentities)
              .values({
                userId: created.id,
                provider: 'max',
                externalUserId,
                username: max.user.username ?? null,
                firstName: max.user.firstName,
                lastName: max.user.lastName ?? null,
                languageCode: max.user.languageCode ?? null,
                avatarUrl: max.user.photoUrl ?? null,
                canMessage: true,
                lastSeenAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing()
              .returning({ id: userMessengerIdentities.id });
            if (!identity) throw new Error('MAX identity was created concurrently');
            return created;
          });
        } catch {
          databaseUser = await findMaxUser(app.db, externalUserId);
          if (!databaseUser) throw new Error('MAX user resolution failed');
        }
      }

      await Promise.all([
        upsertMessengerIdentity(
          app.db,
          databaseUser.id,
          'max',
          {
            externalUserId,
            username: max.user.username ?? null,
            firstName: max.user.firstName,
            lastName: max.user.lastName ?? null,
            languageCode: max.user.languageCode ?? null,
            avatarUrl: max.user.photoUrl ?? null,
          },
          now,
        ),
        app.db
          .update(users)
          .set({
            avatarUrl: max.user.photoUrl ?? databaseUser.avatarUrl,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(users.id, databaseUser.id)),
      ]);
      await ensureUserRole(app.db, databaseUser.id, 'participant');
      if (app.config.SUPERADMIN_MAX_IDS.includes(externalUserId)) {
        await ensureUserRole(app.db, databaseUser.id, 'superadmin');
      }
      const session = await createSession(app, reply, databaseUser.id, {
        provider: 'max',
        externalUserId,
      });
      const authenticated = await loadAuthenticatedUser(app.db, databaseUser.id);
      if (!authenticated) throw new Error('Authenticated MAX user disappeared');
      return authPayload(authenticated, session);
    },
  );

  app.post(
    '/auth/dev',
    {
      schema: {
        tags: ['auth'],
        summary: 'Локальная авторизация (недоступна в production)',
      },
    },
    async (request, reply) => {
      if (app.config.NODE_ENV === 'production' || !app.config.DEV_AUTH_ENABLED) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } });
      }
      const telegramId = String(
        (request.body as { telegramUserId?: string } | null)?.telegramUserId ?? '999000111',
      );
      if (!/^\d+$/.test(telegramId)) {
        return reply.code(400).send({
          error: { code: 'INVALID_ID', message: 'Некорректный Telegram ID' },
        });
      }
      const [databaseUser] = await app.db
        .insert(users)
        .values({
          telegramUserId: BigInt(telegramId),
          telegramFirstName: 'Локальный',
          telegramLastName: 'Пользователь',
          fullName: 'Локальный Пользователь',
          consentAt: new Date(),
        })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: { lastSeenAt: new Date() },
        })
        .returning();
      if (!databaseUser) throw new Error('Dev user upsert returned no row');
      await ensureUserRole(app.db, databaseUser.id, 'participant');
      if (app.config.SUPERADMIN_TELEGRAM_IDS.includes(telegramId) || telegramId === '999000111') {
        await ensureUserRole(app.db, databaseUser.id, 'superadmin');
      }
      await ensureWalletBootstrap(app.db, databaseUser.id);
      await upsertMessengerIdentity(
        app.db,
        databaseUser.id,
        'telegram',
        {
          externalUserId: telegramId,
          username: null,
          firstName: 'Локальный',
          lastName: 'Пользователь',
          languageCode: 'ru',
          avatarUrl: null,
        },
        new Date(),
      );
      const session = await createSession(app, reply, databaseUser.id, {
        provider: 'telegram',
        externalUserId: telegramId,
      });
      const authenticated = await loadAuthenticatedUser(app.db, databaseUser.id);
      if (!authenticated) throw new Error('Dev user disappeared');
      return authPayload(authenticated, session);
    },
  );

  app.post(
    '/auth/logout',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['auth'] },
    },
    async (request, reply) => {
      await destroySession(app, reply, request.session?.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/session',
    { preHandler: app.requireAuth, schema: { tags: ['auth'] } },
    async (request) => authPayload(request.currentUser!, request.session!),
  );
};
