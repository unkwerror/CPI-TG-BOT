import Fastify from 'fastify';
import type { Database } from '@cpi/db';
import { describe, expect, it, vi } from 'vitest';
import { coworkingRoutes } from './coworking';

const id = '00000000-0000-4000-8000-000000000777';
const endpoints = [
  ['GET', '/coworking/bookings/me'],
  ['POST', '/coworking/bookings'],
  ['PATCH', '/coworking/bookings/' + id + '/cancel'],
  ['GET', '/admin/coworking/bookings'],
  ['PATCH', '/admin/coworking/bookings/' + id],
] as const;

async function guardedApp(authenticated: boolean, admin: boolean, csrf: boolean) {
  const app = Fastify();
  const select = vi.fn(() => {
    throw new Error('Database must not be reached');
  });
  const transaction = vi.fn(() => {
    throw new Error('Database must not be reached');
  });
  app.decorate('db', { select, transaction } as unknown as Database);
  app.decorate('requireAuth', async (_request, reply) => {
    if (!authenticated) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.decorate('requireAdmin', async (_request, reply) => {
    if (!admin) return reply.code(403).send({ error: 'forbidden' });
  });
  app.decorate('requireCsrf', async (_request, reply) => {
    if (!csrf) return reply.code(403).send({ error: 'csrf' });
  });
  await app.register(coworkingRoutes);
  return { app, select, transaction };
}

describe('coworking route guards', () => {
  it.each(endpoints)('rejects unauthenticated %s %s before accessing data', async (method, url) => {
    const { app, select, transaction } = await guardedApp(false, false, false);
    try {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(select).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each(endpoints.filter(([method]) => method !== 'GET'))(
    'requires CSRF for %s %s',
    async (method, url) => {
      const { app, select, transaction } = await guardedApp(true, true, false);
      try {
        expect((await app.inject({ method, url })).statusCode).toBe(403);
        expect(select).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it.each(endpoints.filter(([, url]) => url.startsWith('/admin/')))(
    'rejects participant access to %s %s',
    async (method, url) => {
      const { app, select, transaction } = await guardedApp(true, false, true);
      try {
        expect((await app.inject({ method, url })).statusCode).toBe(403);
        expect(select).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
