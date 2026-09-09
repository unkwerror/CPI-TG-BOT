import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, eventQuickAnswers, events, submissions, users } from '@cpi/db';
import { AppError } from '@cpi/shared';
import { ZodError } from 'zod';
import { quickAnswerRoutes } from './quick-answers';
import { loadQuickAnswerSheet } from '../../../worker/src/exporter';
import type { WorkerContext } from '../../../worker/src/context';

const databaseUrl = process.env.QUICK_ANSWER_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('quick answers with PostgreSQL', () => {
  const { db, pool } = createDatabase(databaseUrl ?? 'postgresql://unused');
  const app = Fastify();
  beforeAll(async () => {
    app.decorate('db', db);
    app.decorate('requireAuth', async (request, reply) => {
      const id = request.headers['x-test-user'];
      if (typeof id !== 'string') return reply.code(401).send();
      const [user] = await db.select().from(users).where(eq(users.id, id));
      if (!user) return reply.code(401).send();
      request.currentUser = { ...user, roles: ['participant'] };
    });
    app.decorate('requireCsrf', async (request, reply) => {
      if (request.headers['x-test-csrf'] !== 'valid') return reply.code(403).send();
    });
    app.setErrorHandler((error, _request, reply) => {
      const code =
        error instanceof AppError ? error.statusCode : error instanceof ZodError ? 400 : 500;
      return reply
        .code(code)
        .send({ error: error instanceof Error ? error.message : 'Unknown error' });
    });
    await app.register(quickAnswerRoutes);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function fixture(status: 'running' | 'draft' | 'finished' = 'running', complete = true) {
    const [user] = await db
      .insert(users)
      .values({
        fullName: complete ? 'Иванов Иван Иванович' : null,
        consentAt: complete ? new Date() : null,
      })
      .returning();
    const id = randomUUID();
    const now = Date.now();
    await db.insert(events).values({
      id,
      title: 'Quick answer test',
      slug: id,
      shortCode: id.slice(0, 12),
      organizer: 'QA',
      startsAt: new Date(now - 3_600_000),
      endsAt: new Date(now + 3_600_000),
      acceptUploadsFrom: new Date(now - 3_600_000),
      acceptUploadsUntil: new Date(now + (status === 'finished' ? -1000 : 3_600_000)),
      status,
    });
    const headers = { 'x-test-user': user!.id, 'x-test-csrf': 'valid' };
    return { eventId: id, userId: user!.id, headers, url: `/events/${id}/quick-answer` };
  }
  it('enforces login and CSRF and validates text', async () => {
    const f = await fixture();
    expect((await app.inject({ method: 'GET', url: f.url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: f.url,
          headers: { 'x-test-user': f.userId },
          payload: { answer: 'answer' },
        })
      ).statusCode,
    ).toBe(403);
    for (const answer of [' ', 'a'.repeat(10_001)]) {
      expect(
        (await app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: { answer } }))
          .statusCode,
      ).toBe(400);
    }
  });
  it('stores one response under concurrent submissions and preserves the original', async () => {
    const f = await fixture();
    const results = await Promise.all(
      ['Первый ответ', 'Второй ответ'].map((answer) =>
        app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: { answer } }),
      ),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    const stored = await db
      .select()
      .from(eventQuickAnswers)
      .where(eq(eventQuickAnswers.eventId, f.eventId));
    expect(stored).toHaveLength(1);
    const replay = await app.inject({
      method: 'POST',
      url: f.url,
      headers: f.headers,
      payload: { answer: stored[0]!.answer },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ answer: { createdAt: string } }>().answer.createdAt).toBe(
      stored[0]!.createdAt.toISOString(),
    );
    expect(
      await db.select().from(submissions).where(eq(submissions.eventId, f.eventId)),
    ).toHaveLength(0);
  });
  it('allows a separate answer per event and returns only the current user answer', async () => {
    const first = await fixture();
    const second = await fixture();
    for (const url of [first.url, second.url]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: first.headers,
            payload: { answer: 'Ответ' },
          })
        ).statusCode,
      ).toBe(201);
    }
    expect(
      (await app.inject({ method: 'GET', url: first.url, headers: second.headers })).json(),
    ).toEqual({ answer: null });
    const own = await app.inject({ method: 'GET', url: first.url, headers: first.headers });
    expect(own.json<{ answer: { answer: string } }>().answer.answer).toBe('Ответ');
  });
  it('rejects draft events, closed reception and incomplete profiles', async () => {
    for (const [status, complete, expected] of [
      ['draft', true, 404],
      ['finished', true, 409],
      ['running', false, 409],
    ] as const) {
      const f = await fixture(status, complete);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: f.url,
            headers: f.headers,
            payload: { answer: 'Ответ' },
          })
        ).statusCode,
      ).toBe(expected);
    }
  });
  it('exports FIO and answer together, including literal Excel formula-like text', async () => {
    const f = await fixture();
    const answer = '=HYPERLINK("https://example.test")\nОтвет <&>';
    expect(
      (await app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: { answer } }))
        .statusCode,
    ).toBe(201);
    await db.update(users).set({ fullName: 'Петров Пётр Петрович' }).where(eq(users.id, f.userId));
    const sheet = await loadQuickAnswerSheet({ db } as WorkerContext, f.eventId);
    expect(sheet.rows).toEqual([{ fullName: 'Иванов Иван Иванович', answer }]);
    expect(sheet.columns.map((column) => column.key)).toEqual(['fullName', 'answer']);
    expect(
      await db
        .select()
        .from(eventQuickAnswers)
        .where(
          and(eq(eventQuickAnswers.eventId, f.eventId), eq(eventQuickAnswers.userId, f.userId)),
        ),
    ).toHaveLength(1);
  });
});
