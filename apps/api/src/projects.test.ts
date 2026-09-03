import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from '@cpi/config';
import type { Database } from '@cpi/db';
import { AppError } from '@cpi/shared';
import { ZodError } from 'zod';
import { escapeLikePattern, projectRoutes } from './routes/projects';

const USER_ID = '00000000-0000-4000-8000-000000000030';
const INVITEE_ID = '00000000-0000-4000-8000-000000000031';
const PROJECT_ID = '00000000-0000-4000-8000-000000000032';

async function testApp(database?: Database) {
  const app = Fastify({ logger: false });
  app.decorate('config', {
    CRM_API_URL: 'https://crm.example.test/api',
    CRM_INTEGRATION_TOKEN: 'x'.repeat(32),
  } as unknown as ApiEnvironment);
  app.decorateRequest('currentUser', undefined);
  app.decorate('requireAuth', async (request) => {
    request.currentUser = {
      id: USER_ID,
      telegramUserId: 123456789n,
      telegramUsername: 'user',
      fullName: 'Иванов Иван Иванович',
      organization: null,
      position: null,
      phone: null,
      consentAt: new Date(),
      status: 'active',
      roles: [],
    };
  });
  app.decorate('requireCsrf', async () => undefined);
  app.decorate('requireAdmin', async () => undefined);
  if (database) app.decorate('db', database);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Проверьте заполненные поля' },
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
    }
    return reply.send(error);
  });
  await app.register(projectRoutes);
  return app;
}

function inviteeDatabase() {
  const source = {
    id: INVITEE_ID,
    fullName: 'Петрова Анна',
    telegramUsername: 'petrova',
    telegramUserId: 987654321n,
    organization: 'Catalyst',
    crmPersonId: '00000000-0000-4000-8000-000000000099',
  };
  let selectedKeys: string[] = [];
  const select = vi.fn((fields: Record<string, unknown>) => {
    selectedKeys = Object.keys(fields);
    const projected = Object.fromEntries(
      selectedKeys.map((key) => [key, source[key as keyof typeof source]]),
    );
    const builder = {
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: async () => [projected],
    };
    return builder;
  });
  return {
    database: { select } as unknown as Database,
    selectedKeys: () => selectedKeys,
  };
}

function parseJsonRequestBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') {
    throw new TypeError('Expected the forwarded request body to be a JSON string');
  }
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Expected the forwarded request body to be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe('projects CRM proxy', () => {
  it('adds the authenticated Locker and Telegram identities to the CRM catalog request', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ schemaVersion: 1, catalog: [], mine: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = await testApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/projects' });
      expect(response.statusCode).toBe(200);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      expect(url.pathname).toBe('/api/integrations/locker/v1/projects/context');
      expect(String(url)).toContain(`lockerUserId=${USER_ID}`);
      expect(String(url)).toContain('telegramUserId=123456789');
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${'x'.repeat(32)}`,
      );
    } finally {
      await app.close();
    }
  });

  it('never accepts an identity from the browser when forwarding a project application', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'application' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = await testApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/projects/applications',
        payload: {
          type: 'CREATE',
          proposedName: 'Проект',
          lockerUserId: '00000000-0000-4000-8000-000000000099',
        },
      });
      expect(response.statusCode).toBe(201);
      const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      const body = parseJsonRequestBody(init);
      expect(body.lockerUserId).toBe(USER_ID);
      expect(body.telegramUserId).toBe('123456789');
    } finally {
      await app.close();
    }
  });

  it('proxies the searchable CRM project registry to the bot admin', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [{ id: 'project' }], total: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = await testApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/projects?q=%D1%80%D0%BE%D0%B1%D0%BE%D1%82&limit=25',
      });
      expect(response.statusCode).toBe(200);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      expect(url.pathname).toBe('/api/integrations/locker/v1/admin/projects');
      expect(url.searchParams.get('q')).toBe('робот');
      expect(url.searchParams.get('limit')).toBe('25');
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${'x'.repeat(32)}`,
      );
    } finally {
      await app.close();
    }
  });

  it.each(['/projects', '/admin/projects'])(
    'does not expose upstream CRM details from %s',
    async (url) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                title: 'CRM validation failed',
                detail: 'client_secret=top-secret was rejected',
              }),
              { status: 422, headers: { 'content-type': 'application/json' } },
            ),
        ),
      );
      const app = await testApp();
      try {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          error: {
            code: 'CRM_PROJECT_REQUEST_FAILED',
            message: 'CRM не смогла обработать запрос. Попробуйте ещё раз',
          },
        });
        expect(response.body).not.toContain('top-secret');
        expect(response.body).not.toContain('client_secret');
      } finally {
        await app.close();
      }
    },
  );

  it('requires a bounded invitee query and returns only the opaque Locker user id', async () => {
    const { database, selectedKeys } = inviteeDatabase();
    const app = await testApp(database);
    try {
      const tooShort = await app.inject({ method: 'GET', url: '/projects/invitees?q=a' });
      const tooLarge = await app.inject({
        method: 'GET',
        url: '/projects/invitees?q=anna&limit=31',
      });
      expect(tooShort.statusCode).toBe(400);
      expect(tooLarge.statusCode).toBe(400);

      const response = await app.inject({
        method: 'GET',
        url: '/projects/invitees?q=anna&limit=30',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            id: INVITEE_ID,
            fullName: 'Петрова Анна',
            telegramUsername: 'petrova',
            organization: 'Catalyst',
          },
        ],
      });
      expect(selectedKeys()).toEqual(['id', 'fullName', 'telegramUsername', 'organization']);
      expect(response.body).not.toContain('crmPersonId');
    } finally {
      await app.close();
    }
  });

  it('escapes SQL LIKE wildcards in invitee search terms', () => {
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\');
  });

  it('keeps the CRM invitation contract on the opaque Locker user id', async () => {
    const { database } = inviteeDatabase();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'invitation' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = await testApp(database);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${PROJECT_ID}/invitations`,
        payload: { userId: INVITEE_ID, role: 'Дизайнер' },
      });
      expect(response.statusCode).toBe(200);
      const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      const body = parseJsonRequestBody(init);
      expect(body).toMatchObject({
        lockerUserId: USER_ID,
        inviteeLockerUserId: INVITEE_ID,
        inviteeTelegramUserId: '987654321',
        role: 'Дизайнер',
      });
      expect(body).not.toHaveProperty('crmPersonId');
    } finally {
      await app.close();
    }
  });
});
