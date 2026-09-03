import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, ilike, isNotNull, ne, or } from 'drizzle-orm';
import { users } from '@cpi/db';
import { AppError } from '@cpi/shared';

const applicationSchema = z
  .object({
    type: z.enum(['CREATE', 'JOIN']),
    projectId: z.uuid().optional(),
    proposedName: z.string().trim().min(1).max(500).optional(),
    proposedDescription: z.string().trim().max(10_000).optional(),
    requestedRole: z.string().trim().min(1).max(500).optional(),
    message: z.string().trim().max(5_000).optional(),
  })
  .superRefine((body, context) => {
    if (body.type === 'CREATE' && !body.proposedName) {
      context.addIssue({
        code: 'custom',
        path: ['proposedName'],
        message: 'Укажите название',
      });
    }
    if (body.type === 'JOIN' && !body.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Выберите проект',
      });
    }
  });

const applicationParams = z.object({ id: z.uuid() });
const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  comment: z.string().trim().max(5_000).optional(),
});

const inviteeQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(30).default(20),
});
const projectParams = z.object({ id: z.uuid() });
const projectMemberParams = z.object({ id: z.uuid(), personId: z.uuid() });
const invitationSchema = z.object({
  userId: z.uuid(),
  role: z.string().trim().min(1).max(500).default('Участник'),
});
const adminProjectQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  status: z.enum(['IDEA', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const adminProjectUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  status: z.enum(['IDEA', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).optional(),
  visibleInBot: z.boolean().optional(),
  leadPersonId: z.uuid().nullable().optional(),
});
const memberRoleSchema = z.object({ role: z.string().trim().min(1).max(500) });

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/projects',
    { preHandler: app.requireAuth, schema: { tags: ['projects'] } },
    async (request) => crmRequest(app, request, '/integrations/locker/v1/projects/context'),
  );

  app.post(
    '/projects/applications',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['projects'] },
    },
    async (request, reply) => {
      const body = applicationSchema.parse(request.body);
      const result = await crmRequest(
        app,
        request,
        '/integrations/locker/v1/project-applications',
        { method: 'POST', body },
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/projects/applications/:id/decision',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['projects'] },
    },
    async (request) => {
      const { id } = applicationParams.parse(request.params);
      const body = decisionSchema.parse(request.body);
      return crmRequest(
        app,
        request,
        `/integrations/locker/v1/project-applications/${encodeURIComponent(id)}/decision`,
        { method: 'POST', body },
      );
    },
  );

  app.get(
    '/projects/invitees',
    { preHandler: app.requireAuth, schema: { tags: ['projects'] } },
    async (request) => {
      const query = inviteeQuerySchema.parse(request.query);
      const conditions = [
        ne(users.id, request.currentUser!.id),
        eq(users.status, 'active'),
        isNotNull(users.crmPersonId),
      ];
      const pattern = `%${escapeLikePattern(query.q)}%`;
      conditions.push(
        or(
          ilike(users.fullName, pattern),
          ilike(users.telegramUsername, pattern),
          ilike(users.organization, pattern),
        )!,
      );
      const items = await app.db
        .select({
          id: users.id,
          fullName: users.fullName,
          telegramUsername: users.telegramUsername,
          organization: users.organization,
        })
        .from(users)
        .where(and(...conditions))
        .orderBy(asc(users.fullName), asc(users.id))
        .limit(query.limit);
      return { items };
    },
  );

  app.post(
    '/projects/:id/invitations',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['projects'] },
    },
    async (request) => {
      const { id } = projectParams.parse(request.params);
      const body = invitationSchema.parse(request.body);
      const [invitee] = await app.db
        .select({ id: users.id, telegramUserId: users.telegramUserId })
        .from(users)
        .where(
          and(eq(users.id, body.userId), eq(users.status, 'active'), isNotNull(users.crmPersonId)),
        )
        .limit(1);
      if (!invitee) {
        throw new AppError(
          'PROJECT_INVITEE_NOT_FOUND',
          'Участник ещё не синхронизирован с CRM',
          404,
        );
      }
      return crmRequest(
        app,
        request,
        `/integrations/locker/v1/projects/${encodeURIComponent(id)}/invitations`,
        {
          method: 'POST',
          body: {
            inviteeLockerUserId: invitee.id,
            ...(invitee.telegramUserId
              ? { inviteeTelegramUserId: invitee.telegramUserId.toString() }
              : {}),
            role: body.role,
          },
        },
      );
    },
  );

  app.get(
    '/admin/projects',
    {
      preHandler: [app.requireAuth, app.requireAdmin],
      schema: { tags: ['admin', 'projects'] },
    },
    async (request) => {
      const query = adminProjectQuerySchema.parse(request.query);
      const parameters = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      if (query.q) parameters.set('q', query.q);
      if (query.status) parameters.set('status', query.status);
      if (query.includeArchived !== undefined) {
        parameters.set('includeArchived', String(query.includeArchived));
      }
      return crmAdminRequest(app, request, `/integrations/locker/v1/admin/projects?${parameters}`);
    },
  );

  app.get(
    '/admin/projects/:id',
    {
      preHandler: [app.requireAuth, app.requireAdmin],
      schema: { tags: ['admin', 'projects'] },
    },
    async (request) => {
      const { id } = projectParams.parse(request.params);
      return crmAdminRequest(
        app,
        request,
        `/integrations/locker/v1/admin/projects/${encodeURIComponent(id)}`,
      );
    },
  );

  app.patch(
    '/admin/projects/:id',
    {
      preHandler: [app.requireAuth, app.requireCsrf, app.requireAdmin],
      schema: { tags: ['admin', 'projects'] },
    },
    async (request) => {
      const { id } = projectParams.parse(request.params);
      const body = adminProjectUpdateSchema.parse(request.body);
      return crmAdminRequest(
        app,
        request,
        `/integrations/locker/v1/admin/projects/${encodeURIComponent(id)}`,
        { method: 'PATCH', body },
      );
    },
  );

  app.delete(
    '/admin/projects/:id',
    {
      preHandler: [app.requireAuth, app.requireCsrf, app.requireAdmin],
      schema: { tags: ['admin', 'projects'] },
    },
    async (request, reply) => {
      const { id } = projectParams.parse(request.params);
      await crmAdminRequest(
        app,
        request,
        `/integrations/locker/v1/admin/projects/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      return reply.code(204).send();
    },
  );

  app.post(
    '/admin/projects/:id/members',
    {
      preHandler: [app.requireAuth, app.requireCsrf, app.requireAdmin],
      schema: { tags: ['admin', 'projects'] },
    },
    async (request) => {
      const { id } = projectParams.parse(request.params);
      const body = invitationSchema.parse(request.body);
      const [invitee] = await app.db
        .select({ id: users.id, telegramUserId: users.telegramUserId })
        .from(users)
        .where(
          and(eq(users.id, body.userId), eq(users.status, 'active'), isNotNull(users.crmPersonId)),
        )
        .limit(1);
      if (!invitee) {
        throw new AppError(
          'PROJECT_INVITEE_NOT_FOUND',
          'Участник ещё не синхронизирован с CRM',
          404,
        );
      }
      return crmAdminRequest(
        app,
        request,
        `/integrations/locker/v1/admin/projects/${encodeURIComponent(id)}/members`,
        {
          method: 'POST',
          body: {
            inviteeLockerUserId: invitee.id,
            ...(invitee.telegramUserId
              ? { inviteeTelegramUserId: invitee.telegramUserId.toString() }
              : {}),
            role: body.role,
          },
        },
      );
    },
  );

  app.patch(
    '/admin/projects/:id/members/:personId',
    {
      preHandler: [app.requireAuth, app.requireCsrf, app.requireAdmin],
      schema: { tags: ['admin', 'projects'] },
    },
    async (request) => {
      const { id, personId } = projectMemberParams.parse(request.params);
      const body = memberRoleSchema.parse(request.body);
      return crmAdminRequest(
        app,
        request,
        `/integrations/locker/v1/admin/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(personId)}`,
        { method: 'PATCH', body },
      );
    },
  );

  app.delete(
    '/admin/projects/:id/members/:personId',
    {
      preHandler: [app.requireAuth, app.requireCsrf, app.requireAdmin],
      schema: { tags: ['admin', 'projects'] },
    },
    async (request, reply) => {
      const { id, personId } = projectMemberParams.parse(request.params);
      await crmAdminRequest(
        app,
        request,
        `/integrations/locker/v1/admin/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(personId)}`,
        { method: 'DELETE' },
      );
      return reply.code(204).send();
    },
  );
};

async function crmRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  path: string,
  mutation?: { method: 'POST'; body: Record<string, unknown> },
): Promise<unknown> {
  if (!app.config.CRM_API_URL) {
    throw new AppError('PROJECTS_UNAVAILABLE', 'Раздел проектов временно недоступен', 503);
  }
  const identity = {
    lockerUserId: request.currentUser!.id,
    messengerProvider: request.session?.messengerProvider ?? 'telegram',
    messengerUserId:
      request.session?.messengerUserId ??
      request.currentUser!.telegramUserId?.toString() ??
      request.currentUser!.id,
    ...(request.currentUser!.telegramUserId
      ? { telegramUserId: request.currentUser!.telegramUserId.toString() }
      : {}),
  };
  const url = new URL(path.replace(/^\/+/, ''), `${app.config.CRM_API_URL.replace(/\/+$/u, '')}/`);
  if (!mutation) {
    url.searchParams.set('lockerUserId', identity.lockerUserId);
    url.searchParams.set('messengerProvider', identity.messengerProvider);
    url.searchParams.set('messengerUserId', identity.messengerUserId);
    if ('telegramUserId' in identity) {
      url.searchParams.set('telegramUserId', identity.telegramUserId);
    }
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: mutation?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${app.config.CRM_INTEGRATION_TOKEN}`,
        'x-request-id': request.id,
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: JSON.stringify({ ...identity, ...mutation.body }) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    request.log.warn({ error }, 'CRM projects request failed');
    throw new AppError('CRM_UNAVAILABLE', 'CRM временно не отвечает. Попробуйте ещё раз', 503);
  }
  const payload = (await response.json().catch(() => null)) as
    { title?: string; detail?: string } | Record<string, unknown> | null;
  if (!response.ok) {
    logCrmRejection(request, response.status, payload, 'CRM projects request rejected');
    throw new AppError(
      'CRM_PROJECT_REQUEST_FAILED',
      'CRM не смогла обработать запрос. Попробуйте ещё раз',
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }
  return payload;
}

async function crmAdminRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  path: string,
  mutation?: {
    method: 'POST' | 'PATCH' | 'DELETE';
    body?: Record<string, unknown>;
  },
): Promise<unknown> {
  if (!app.config.CRM_API_URL) {
    throw new AppError('PROJECTS_UNAVAILABLE', 'Раздел проектов временно недоступен', 503);
  }
  const url = new URL(path.replace(/^\/+/, ''), `${app.config.CRM_API_URL.replace(/\/+$/u, '')}/`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: mutation?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${app.config.CRM_INTEGRATION_TOKEN}`,
        'x-request-id': request.id,
        ...(mutation?.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation?.body ? { body: JSON.stringify(mutation.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    request.log.warn({ error }, 'CRM admin projects request failed');
    throw new AppError('CRM_UNAVAILABLE', 'CRM временно не отвечает. Попробуйте ещё раз', 503);
  }
  const payload = (await response.json().catch(() => null)) as
    { title?: string; detail?: string } | Record<string, unknown> | null;
  if (!response.ok) {
    logCrmRejection(request, response.status, payload, 'CRM admin projects request rejected');
    throw new AppError(
      'CRM_PROJECT_REQUEST_FAILED',
      'CRM не смогла обработать запрос. Попробуйте ещё раз',
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }
  return payload;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function logCrmRejection(
  request: FastifyRequest,
  status: number,
  payload: unknown,
  message: string,
): void {
  request.log.warn(
    {
      crmStatus: status,
      crmProblem: safeCrmProblemForLog(payload),
    },
    message,
  );
}

function safeCrmProblemForLog(payload: unknown): Record<string, string> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const problem = payload as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const field of ['code', 'title', 'detail'] as const) {
    const value = problem[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    result[field] = sanitizeCrmLogValue(value, field === 'detail' ? 1_000 : 300);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeCrmLogValue(value: string, maxLength: number): string {
  const normalized = value
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, maxLength);
  if (
    /(?:authorization|bearer|token|secret|password|api[ _-]?key|cookie|client[ _-]?secret)/iu.test(
      normalized,
    )
  ) {
    return '[REDACTED]';
  }
  return normalized;
}
