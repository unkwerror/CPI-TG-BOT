import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { roles, userRoles, users } from '@cpi/db';
import { AppError, isAdmin, type RoleName } from '@cpi/shared';
import type { AuthenticatedUser, SessionData } from './types';

const sessionKey = (id: string) => `session:${id}`;

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function loadAuthenticatedUser(
  database: Parameters<FastifyPluginAsync>[0]['db'],
  userId: string,
): Promise<AuthenticatedUser | null> {
  const rows = await database
    .select({
      id: users.id,
      telegramUserId: users.telegramUserId,
      telegramUsername: users.telegramUsername,
      fullName: users.fullName,
      organization: users.organization,
      position: users.position,
      phone: users.phone,
      consentAt: users.consentAt,
      status: users.status,
      role: roles.name,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(users.id, userId));

  const first = rows[0];
  if (!first) return null;
  return {
    id: first.id,
    telegramUserId: first.telegramUserId,
    telegramUsername: first.telegramUsername,
    fullName: first.fullName,
    organization: first.organization,
    position: first.position,
    phone: first.phone,
    consentAt: first.consentAt,
    status: first.status,
    roles: rows.flatMap((row) => (row.role ? [row.role] : [])),
  };
}

export async function createSession(
  app: Parameters<FastifyPluginAsync>[0],
  reply: FastifyReply,
  userId: string,
): Promise<SessionData> {
  const session: SessionData = {
    id: randomToken(),
    userId,
    csrfToken: randomToken(24),
    createdAt: new Date().toISOString(),
  };
  await app.redis.set(
    sessionKey(session.id),
    JSON.stringify(session),
    'EX',
    app.config.SESSION_TTL_SECONDS,
  );
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: app.config.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: app.config.SESSION_TTL_SECONDS,
    ...(app.config.COOKIE_DOMAIN ? { domain: app.config.COOKIE_DOMAIN } : {}),
  };
  reply.setCookie(app.config.SESSION_COOKIE_NAME, session.id, cookieOptions);
  return session;
}

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate('requireAuth', async (request) => {
    const cookieSession = request.cookies[app.config.SESSION_COOKIE_NAME];
    const authorization = request.headers.authorization;
    const bearerSession = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const id = cookieSession ?? bearerSession;
    if (!id || id.length > 128) {
      throw new AppError('AUTH_REQUIRED', 'Необходима авторизация через Telegram', 401);
    }
    const raw = await app.redis.get(sessionKey(id));
    if (!raw)
      throw new AppError('SESSION_EXPIRED', 'Сессия истекла, откройте приложение заново', 401);

    let session: SessionData;
    try {
      session = JSON.parse(raw) as SessionData;
    } catch {
      await app.redis.del(sessionKey(id));
      throw new AppError('SESSION_INVALID', 'Сессия повреждена', 401);
    }
    const user = await loadAuthenticatedUser(app.db, session.userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 'Пользователь не найден', 401);
    if (user.status === 'blocked') {
      throw new AppError('USER_BLOCKED', 'Учётная запись заблокирована', 403);
    }
    request.session = session;
    request.currentUser = user;
    await app.redis.expire(sessionKey(id), app.config.SESSION_TTL_SECONDS);
  });

  app.decorate('requireCsrf', async (request) => {
    if (!request.session) throw new AppError('AUTH_REQUIRED', 'Необходима авторизация', 401);
    const received = request.headers['x-csrf-token'];
    if (typeof received !== 'string' || received !== request.session.csrfToken) {
      throw new AppError('CSRF_INVALID', 'Защитный токен отсутствует или устарел', 403);
    }
  });

  app.decorate('requireAdmin', async (request) => {
    if (!request.currentUser || !isAdmin(request.currentUser.roles)) {
      throw new AppError('ADMIN_REQUIRED', 'Недостаточно прав администратора', 403);
    }
  });

  app.decorate('requireSuperadmin', async (request) => {
    if (!request.currentUser?.roles.includes('superadmin')) {
      throw new AppError('SUPERADMIN_REQUIRED', 'Требуются права суперадминистратора', 403);
    }
  });
});

export async function ensureUserRole(
  database: Parameters<FastifyPluginAsync>[0]['db'],
  userId: string,
  roleName: RoleName,
): Promise<void> {
  const [role] = await database.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`Role ${roleName} is not seeded`);
  await database
    .insert(userRoles)
    .values({ userId, roleId: role.id, assignedBy: userId })
    .onConflictDoNothing();
}

export async function revokeUserRole(
  database: Parameters<FastifyPluginAsync>[0]['db'],
  userId: string,
  roleName: RoleName,
): Promise<void> {
  const [role] = await database.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) return;
  await database
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, role.id)));
}

export async function destroySession(
  app: Parameters<FastifyPluginAsync>[0],
  reply: FastifyReply,
  sessionId: string | undefined,
): Promise<void> {
  if (sessionId) await app.redis.del(sessionKey(sessionId));
  reply.clearCookie(app.config.SESSION_COOKIE_NAME, { path: '/' });
}
