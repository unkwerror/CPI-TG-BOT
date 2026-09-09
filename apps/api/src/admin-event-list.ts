import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { events, type Database } from '@cpi/db';
import { parseCursorPagination, type adminEventListQuerySchema } from '@cpi/shared';
import type { z } from 'zod';

export type AdminEventListQuery = z.infer<typeof adminEventListQuerySchema>;

export async function listAdminEvents(db: Database, query: AdminEventListQuery, now = new Date()) {
  const conditions = [isNull(events.deletedAt)];
  if (query.status) conditions.push(eq(events.status, query.status));
  for (const term of query.q?.split(/\s+/u).filter(Boolean) ?? []) {
    // Treat %, _ and backslashes as literal text, not SQL search wildcards.
    const pattern = `%${term.replace(/[\\%_]/gu, '\\$&')}%`;
    conditions.push(
      or(
        ilike(events.title, pattern),
        ilike(events.shortCode, pattern),
        ilike(events.organizer, pattern),
        ilike(events.city, pattern),
        ilike(sql`${events.leaderIdEventId}::text`, pattern),
      )!,
    );
  }
  switch (query.period) {
    case 'upcoming':
      conditions.push(gt(events.startsAt, now));
      break;
    case 'ongoing':
      conditions.push(lte(events.startsAt, now), gt(events.endsAt, now));
      break;
    case 'past':
      conditions.push(lte(events.endsAt, now));
      break;
    case 'accepting':
      conditions.push(
        inArray(events.status, ['published', 'running']),
        lte(events.acceptUploadsFrom, now),
        gte(events.acceptUploadsUntil, now),
      );
      break;
  }
  const title = sql`lower(${events.title})`;
  const primaryOrder = {
    created_desc: desc(events.createdAt),
    starts_desc: desc(events.startsAt),
    starts_asc: asc(events.startsAt),
    title_asc: asc(title),
    title_desc: desc(title),
  }[query.sort];

  if (query.page !== undefined) {
    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(primaryOrder, asc(events.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      db
        .select({ total: count() })
        .from(events)
        .where(and(...conditions)),
    ]);
    const total = totalRow?.total ?? 0;
    return {
      items: rows,
      total,
      page: query.page,
      pageCount: Math.max(1, Math.ceil(total / query.limit)),
      nextCursor: null,
    };
  }

  // Preserve cursor clients, using both fields from the actual stable sort.
  if (query.cursor) {
    const [cursor] = await db
      .select({ createdAt: events.createdAt })
      .from(events)
      .where(eq(events.id, query.cursor))
      .limit(1);
    if (!cursor) return { items: [], nextCursor: null };
    conditions.push(
      or(
        lt(events.createdAt, cursor.createdAt),
        and(eq(events.createdAt, cursor.createdAt), gt(events.id, query.cursor)),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(primaryOrder, asc(events.id))
    .limit(query.limit + 1);
  return parseCursorPagination(rows, query.limit);
}
