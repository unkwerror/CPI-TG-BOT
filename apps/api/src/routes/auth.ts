import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { telegramAuthSchema, type AuthResponse } from '@cpi/shared';
import { users } from '@cpi/db';
import {
  createSession,
  destroySession,
  ensureUserRole,
  loadAuthenticatedUser,
} from '../auth';
import { verifyTelegramInitData } from '../telegram-auth';

function authPayload(
  user: NonNullable<Awaited<ReturnType<typeof loadAuthenticatedUser>>>,
  csrfToken: string,
): AuthResponse {
  return {
    user: {
      id: user.id,
      telegramUserId: user.telegramUserId.toString(),
      fullName: user.fullName,
      roles: user.roles,
      profileComplete: Boolean(user.fullName && user.consentAt),
    },
    csrfToken,
  };
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
      const inferredFullName = [telegram.user.firstName, telegram.user.lastName].filter(Boolean).join(' ');
      const [databaseUser] = await app.db
        .insert(users)
        .values({
          telegramUserId: telegram.user.id,
          telegramUsername: telegram.user.username ?? null,
          telegramFirstName: telegram.user.firstName,
          telegramLastName: telegram.user.lastName ?? null,
          telegramLanguageCode: telegram.user.languageCode ?? null,
          avatarUrl: telegram.user.photoUrl ?? null,
          fullName: inferredFullName || null,
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

      await ensureUserRole(app.db, databaseUser.id, 'participant');
      if (app.config.SUPERADMIN_TELEGRAM_IDS.includes(telegram.user.id.toString())) {
        await ensureUserRole(app.db, databaseUser.id, 'superadmin');
      }
      const session = await createSession(app, reply, databaseUser.id);
      const authenticated = await loadAuthenticatedUser(app.db, databaseUser.id);
      if (!authenticated) throw new Error('Authenticated user disappeared');
      return authPayload(authenticated, session.csrfToken);
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
        return reply
          .code(400)
          .send({ error: { code: 'INVALID_ID', message: 'Некорректный Telegram ID' } });
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
      const session = await createSession(app, reply, databaseUser.id);
      const authenticated = await loadAuthenticatedUser(app.db, databaseUser.id);
      if (!authenticated) throw new Error('Dev user disappeared');
      return authPayload(authenticated, session.csrfToken);
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: [app.requireAuth, app.requireCsrf], schema: { tags: ['auth'] } },
    async (request, reply) => {
      await destroySession(app, reply, request.session?.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/session',
    { preHandler: app.requireAuth, schema: { tags: ['auth'] } },
    async (request) => authPayload(request.currentUser!, request.session!.csrfToken),
  );
};
