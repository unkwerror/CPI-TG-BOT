import Fastify from 'fastify';
import type { Database } from '@cpi/db';
import { describe, expect, it, vi } from 'vitest';
import { adminExportRoutes } from './admin-exports';

describe('export permissions', () => {
  it.each([
    ['POST', '/admin/exports', 'users'],
    ['POST', '/admin/exports', 'quick_answers'],
    ['GET', '/admin/exports?scope=users', undefined],
    ['GET', '/admin/exports/00000000-0000-4000-8000-000000000111/download', undefined],
  ] as const)('requires admin for %s %s (%s)', async (method, url, scope) => {
    const app = Fastify();
    const select = vi.fn(() => {
      throw new Error('Must not read private export data');
    });
    app.decorate('db', { select } as unknown as Database);
    app.decorate('requireAuth', async () => {});
    app.decorate('requireCsrf', async () => {});
    app.decorate('requireAdmin', async (_request, reply) => reply.code(403).send());
    await app.register(adminExportRoutes);
    const response = await app.inject({
      method,
      url,
      ...(scope ? { payload: { scope, kind: 'xlsx' } } : {}),
    });
    expect(response.statusCode).toBe(403);
    expect(select).not.toHaveBeenCalled();
    await app.close();
  });
});
