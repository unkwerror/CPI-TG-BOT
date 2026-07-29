import { eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { roles, userRoles, users } from '@cpi/db';
import { AppError } from '@cpi/shared';
import { ensureUserRole, revokeUserRole } from '../auth';
import { writeAudit } from '../audit';
import { serializeUser } from '../serializers';

const roleChangeSchema = z.object({
  role: z.enum(['admin', 'superadmin']),
  enabled: z.boolean(),
});

const statusChangeSchema = z.object({
  status: z.enum(['active', 'blocked']),
});

export const adminRoleRoutes: FastifyPluginAsync = async (app) => {
  const readGuards = [app.requireAuth, app.requireSuperadmin];
  const writeGuards = [app.requireAuth, app.requireCsrf, app.requireSuperadmin];

  app.get(
    '/admin/admins',
    { preHandler: readGuards, schema: { tags: ['admin', 'roles'] } },
    async () => {
      const rows = await app.db
        .select({ user: users, role: roles.name })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(inArray(roles.name, ['admin', 'superadmin']));
      const grouped = new Map<string, ReturnType<typeof serializeUser> & { roles: string[] }>();
      for (const row of rows) {
        const existing = grouped.get(row.user.id);
        if (existing) existing.roles.push(row.role);
        else grouped.set(row.user.id, { ...serializeUser(row.user), roles: [row.role] });
      }
      return { items: [...grouped.values()] };
    },
  );

  app.patch(
    '/admin/users/:userId/role',
    { preHandler: writeGuards, schema: { tags: ['admin', 'roles'] } },
    async (request) => {
      const { userId } = request.params as { userId: string };
      const body = roleChangeSchema.parse(request.body);
      const [target] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) throw new AppError('USER_NOT_FOUND', 'Пользователь не найден', 404);
      if (!body.enabled && userId === request.currentUser!.id && body.role === 'superadmin') {
        throw new AppError(
          'CANNOT_REVOKE_SELF',
          'Нельзя снять собственную роль суперадминистратора',
          409,
        );
      }
      if (body.enabled) await ensureUserRole(app.db, userId, body.role);
      else await revokeUserRole(app.db, userId, body.role);
      await writeAudit(request, {
        action: body.enabled ? 'role.assign' : 'role.revoke',
        entityType: 'user',
        entityId: userId,
        metadata: { role: body.role },
      });
      return { ok: true };
    },
  );

  app.patch(
    '/admin/users/:userId/status',
    { preHandler: writeGuards, schema: { tags: ['admin', 'roles'] } },
    async (request) => {
      const { userId } = request.params as { userId: string };
      const body = statusChangeSchema.parse(request.body);
      if (userId === request.currentUser!.id && body.status === 'blocked') {
        throw new AppError(
          'CANNOT_BLOCK_SELF',
          'Нельзя заблокировать собственную учётную запись',
          409,
        );
      }
      const [target] = await app.db
        .update(users)
        .set({ status: body.status })
        .where(eq(users.id, userId))
        .returning();
      if (!target) throw new AppError('USER_NOT_FOUND', 'Пользователь не найден', 404);
      await writeAudit(request, {
        action: body.status === 'blocked' ? 'user.block' : 'user.unblock',
        entityType: 'user',
        entityId: userId,
      });
      return serializeUser(target);
    },
  );
};
