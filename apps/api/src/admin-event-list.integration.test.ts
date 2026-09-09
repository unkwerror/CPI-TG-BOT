import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, events } from '@cpi/db';
import { adminEventListQuerySchema } from '@cpi/shared';
import { ZodError } from 'zod';
import { listAdminEvents } from './admin-event-list';
import { adminRoutes } from './routes/admin';

const databaseUrl = process.env.ADMIN_EVENT_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('admin event search with PostgreSQL', () => {
  const { db, pool } = createDatabase(databaseUrl ?? 'postgresql://unused');
  const app = Fastify();
  const ids: string[] = [];
  const marker = `listqa${randomUUID().replaceAll('-', '')}`;
  const now = new Date('2026-09-09T12:00:00Z');
  const hour = 3_600_000;
  const time = (offset: number) => new Date(now.getTime() + offset * hour);
  const rows = Array.from({ length: 130 }, (_, index) => {
    const id = randomUUID();
    return {
      id,
      slug: id,
      shortCode: `CODE${id.slice(0, 8)}`,
      title: `${marker} Batch ${String(index).padStart(3, '0')}`,
      organizer: 'Test organizer',
      city: 'Томск',
      status: 'published' as const,
      startsAt: time(20 + Math.floor(index / 3)),
      endsAt: time(22 + Math.floor(index / 3)),
      acceptUploadsFrom: time(-1),
      acceptUploadsUntil: time(24),
      createdAt: time(-index),
    };
  });
  async function fixture(values: Partial<typeof events.$inferInsert>) {
    const id = randomUUID();
    ids.push(id);
    const [row] = await db
      .insert(events)
      .values({
        ...rows[0]!,
        id,
        slug: id,
        shortCode: `F${id.slice(0, 12)}`,
        ...values,
      })
      .returning();
    return row!;
  }
  const query = (values: Record<string, unknown> = {}) =>
    adminEventListQuerySchema.parse({ q: marker, page: 1, limit: 20, ...values });
  beforeAll(async () => {
    ids.push(...rows.map((row) => row.id));
    await db.insert(events).values(rows);
    await fixture({ title: `${marker} Batch deleted`, deletedAt: now });
    app.decorate('db', db);
    app.decorate('requireAuth', async (request, reply) => {
      if (!request.headers['x-test-role']) return reply.code(401).send();
    });
    app.decorate('requireCsrf', async () => {});
    app.decorate('requireAdmin', async (request, reply) => {
      if (request.headers['x-test-role'] !== 'admin') return reply.code(403).send();
    });
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ZodError ? 400 : 500).send(),
    );
    await app.register(adminRoutes);
  });
  afterAll(async () => {
    if (ids.length) await db.delete(events).where(inArray(events.id, ids));
    await app.close();
    await pool.end();
  });

  it('searches beyond the first 100 events and returns total and page count', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/events?q=${marker}+Batch&page=7&limit=20&sort=created_desc`,
      headers: { 'x-test-role': 'admin' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: Array<{ id: string }>;
      total: number;
      page: number;
      pageCount: number;
    }>();
    expect(body).toMatchObject({ total: 130, page: 7, pageCount: 7 });
    expect(body.items.map((row) => row.id)).toEqual(rows.slice(120).map((row) => row.id));
    const result = await listAdminEvents(db, query({ q: `${marker} Batch 129` }), now);
    expect(result.items.map((row) => row.id)).toEqual([rows[129]!.id]);
  });

  it('combines search words across name, code, organizer, city and Leader ID case-insensitively', async () => {
    const row = await fixture({
      title: `${marker} Отдельная встреча`,
      shortCode: `FIND_${marker.slice(-8)}`,
      organizer: 'Стартап-студия НГУ',
      city: 'Новосибирск',
      leaderIdEventId: 12345678,
    });
    for (const term of [
      'ОТДЕЛЬНАЯ',
      row.shortCode.toLowerCase(),
      'нгу',
      'НОВОСИБИРСК',
      '12345678',
      'встреча НГУ новосибирск',
    ]) {
      const result = await listAdminEvents(db, query({ q: `${marker} ${term}` }), now);
      expect(result.items.map((item) => item.id)).toEqual([row.id]);
    }
  });

  it('treats wildcard characters and SQL-like input literally', async () => {
    const row = await fixture({ title: `${marker} 100% A_B Path\\Name` });
    await fixture({ title: `${marker} 1000 AXB PathXName` });
    for (const term of ['100%', 'A_B', 'Path\\Name']) {
      const result = await listAdminEvents(db, query({ q: `${marker} ${term}` }), now);
      expect(result.items.map((item) => item.id)).toEqual([row.id]);
    }
    expect((await listAdminEvents(db, query({ q: `${marker} ' OR '1'='1` }), now)).items).toEqual(
      [],
    );
  });

  it('supports all sort orders with a stable ID tie-breaker', async () => {
    const sortMarker = `${marker} Sorting`;
    const a = await fixture({
      title: `${sortMarker} Альфа`,
      startsAt: time(4),
      createdAt: time(-3),
    });
    const b = await fixture({
      title: `${sortMarker} Бета`,
      startsAt: time(1),
      createdAt: time(-1),
    });
    const c = await fixture({
      title: `${sortMarker} Ярмарка`,
      startsAt: time(4),
      createdAt: time(-2),
    });
    const tie = [a.id, c.id].sort();
    const expected = {
      starts_asc: [b.id, ...tie],
      starts_desc: [...tie, b.id],
      created_desc: [b.id, c.id, a.id],
      title_asc: [a.id, b.id, c.id],
      title_desc: [c.id, b.id, a.id],
    };
    for (const [sort, resultIds] of Object.entries(expected)) {
      const result = await listAdminEvents(db, query({ q: sortMarker, sort }), now);
      expect(result.items.map((item) => item.id)).toEqual(resultIds);
    }
    const collected = [];
    for (let page = 1; page <= 7; page++) {
      const result = await listAdminEvents(
        db,
        query({ q: `${marker} Batch`, sort: 'starts_asc', page }),
        now,
      );
      collected.push(...result.items.map((item) => item.id));
    }
    expect(collected).toHaveLength(130);
    expect(new Set(collected).size).toBe(130);
  });

  it('combines status and date filters and matches the actual upload acceptance policy', async () => {
    const periodMarker = `${marker} Period`;
    const past = await fixture({
      title: periodMarker,
      status: 'finished',
      startsAt: time(-4),
      endsAt: now,
    });
    const ongoing = await fixture({
      title: periodMarker,
      status: 'running',
      startsAt: now,
      endsAt: time(1),
      acceptUploadsUntil: now,
    });
    const upcoming = await fixture({
      title: periodMarker,
      status: 'published',
      startsAt: time(1),
      endsAt: time(2),
    });
    const draft = await fixture({
      title: periodMarker,
      status: 'draft',
      startsAt: time(2),
      endsAt: time(3),
    });
    const check = async (period: string, expected: string[], status?: string) => {
      const result = await listAdminEvents(
        db,
        query({ q: periodMarker, period, ...(status ? { status } : {}) }),
        now,
      );
      expect(result.items.map((item) => item.id).sort()).toEqual(expected.sort());
    };
    await check('past', [past.id]);
    await check('ongoing', [ongoing.id]);
    await check('upcoming', [upcoming.id, draft.id]);
    await check('upcoming', [draft.id], 'draft');
    await check('accepting', [ongoing.id, upcoming.id]);
    await check('accepting', [], 'draft');
  });

  it('preserves legacy cursor pagination without losing events with older creation dates', async () => {
    let cursor: string | undefined;
    const collected: string[] = [];
    do {
      const result = await listAdminEvents(
        db,
        adminEventListQuerySchema.parse({ q: `${marker} Batch`, limit: 25, cursor }),
        now,
      );
      collected.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor && collected.length < 200);
    expect(collected).toEqual(rows.map((row) => row.id));
  });

  it('preserves PostgreSQL microseconds and ID ties at cursor page boundaries', async () => {
    const precisionMarker = `${marker} Microsecond`;
    const preciseRows = await Promise.all(
      Array.from({ length: 4 }, () => fixture({ title: precisionMarker })),
    );
    const timestamps = [
      '2026-09-09T12:00:00.123456Z',
      '2026-09-09T12:00:00.123456Z',
      '2026-09-09T12:00:00.123455Z',
      '2026-09-09T12:00:00.122999Z',
    ];
    for (const [index, row] of preciseRows.entries()) {
      await pool.query('update events set created_at=$1::timestamptz where id=$2::uuid', [
        timestamps[index],
        row.id,
      ]);
    }
    const expected = [
      ...preciseRows
        .slice(0, 2)
        .map((row) => row.id)
        .sort(),
      preciseRows[2]!.id,
      preciseRows[3]!.id,
    ];
    for (const limit of [1, 2]) {
      let cursor: string | undefined;
      const collected: string[] = [];
      do {
        const result = await listAdminEvents(
          db,
          adminEventListQuerySchema.parse({ q: precisionMarker, limit, cursor }),
          now,
        );
        collected.push(...result.items.map((row) => row.id));
        cursor = result.nextCursor ?? undefined;
      } while (cursor && collected.length < 10);
      expect(collected).toEqual(expected);
    }
    expect(
      await listAdminEvents(
        db,
        adminEventListQuerySchema.parse({ q: precisionMarker, cursor: randomUUID() }),
        now,
      ),
    ).toEqual({ items: [], nextCursor: null });
  });

  it('returns an empty result with a valid page count for no matches and an out-of-range page', async () => {
    expect(await listAdminEvents(db, query({ q: `${marker} Missing` }), now)).toMatchObject({
      items: [],
      total: 0,
      pageCount: 1,
    });
    expect(await listAdminEvents(db, query({ q: `${marker} Batch`, page: 99 }), now)).toMatchObject(
      { items: [], total: 130, pageCount: 7 },
    );
  });

  it('updates totals when the last item on a page is removed', async () => {
    const deletionMarker = `${marker} Deletion`;
    const first = await fixture({ title: deletionMarker });
    const second = await fixture({ title: deletionMarker });
    expect(
      await listAdminEvents(db, query({ q: deletionMarker, limit: 1, page: 2 }), now),
    ).toMatchObject({ total: 2, pageCount: 2 });
    await db.delete(events).where(eq(events.id, second.id));
    expect(
      await listAdminEvents(db, query({ q: deletionMarker, limit: 1, page: 2 }), now),
    ).toMatchObject({ items: [], total: 1, pageCount: 1 });
    expect(
      (await listAdminEvents(db, query({ q: deletionMarker, limit: 1 }), now)).items[0]?.id,
    ).toBe(first.id);
  });

  it('requires an authenticated administrator', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/events?page=1' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/admin/events?page=1',
          headers: { 'x-test-role': 'participant' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('rejects invalid filters and incompatible pagination before querying', async () => {
    for (const suffix of [
      'page=0',
      'page=1.5',
      'limit=101',
      'sort=starts_at%3BDROP',
      'status=unknown',
      'period=tomorrow',
      `q=${'x'.repeat(201)}`,
      `page=1&cursor=${rows[0]!.id}`,
      `sort=title_asc&cursor=${rows[0]!.id}`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/admin/events?${suffix}`,
        headers: { 'x-test-role': 'admin' },
      });
      expect(response.statusCode, suffix).toBe(400);
    }
  });
});
