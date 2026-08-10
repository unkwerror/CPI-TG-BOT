import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { eventRequests, events, users, type Database } from '@cpi/db';
import { decodeKeysetCursor, type EventRequestStatus } from '@cpi/shared';

export interface EventRequestQuery {
  q?: string | undefined;
  status?: EventRequestStatus | undefined;
  eventId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface EventRequestRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  status: string;
  text: string;
  attachmentCount: number;
  eventId: string;
  eventTitle: string;
  eventShortCode: string;
  userId: string;
  authorName: string | null;
  authorTelegramName: string | null;
  authorUsername: string | null;
  authorTelegramUserId: string;
  authorPhone: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
}

const assignee = alias(users, 'assignee');

function requestColumns() {
  return {
    id: eventRequests.id,
    createdAt: eventRequests.createdAt,
    updatedAt: eventRequests.updatedAt,
    status: eventRequests.status,
    text: eventRequests.text,
    attachmentCount: sql<number>`jsonb_array_length(${eventRequests.attachments})`,
    eventId: events.id,
    eventTitle: events.title,
    eventShortCode: events.shortCode,
    userId: users.id,
    authorName: users.fullName,
    authorTelegramName: sql<string | null>`nullif(trim(concat_ws(' ',
      ${users.telegramFirstName}, ${users.telegramLastName})), '')`,
    authorUsername: users.telegramUsername,
    authorTelegramUserId: users.telegramUserId,
    authorPhone: users.phone,
    assignedTo: eventRequests.assignedTo,
    assigneeName: assignee.fullName,
  };
}

export function requestConditions(query: EventRequestQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.status) conditions.push(eq(eventRequests.status, query.status));
  if (query.eventId) conditions.push(eq(eventRequests.eventId, query.eventId));
  if (query.q) {
    const pattern = `%${query.q}%`;
    // Телефон хранится с пробелами и дефисами, а ищут его цифрами подряд.
    const digits = query.q.replace(/\D/gu, '');
    const parts = [
      ilike(users.fullName, pattern),
      ilike(users.telegramUsername, pattern),
      ilike(eventRequests.text, pattern),
      ilike(events.title, pattern),
    ];
    if (digits.length >= 4) {
      parts.push(
        sql`regexp_replace(coalesce(${users.phone}, ''), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}`,
      );
      parts.push(sql`${users.telegramUserId}::text LIKE ${`%${digits}%`}`);
    }
    conditions.push(or(...parts)!);
  }
  return conditions;
}

function cursorCondition(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const position = decodeKeysetCursor(cursor);
  if (!position) return undefined;
  return sql`(${eventRequests.createdAt}, ${eventRequests.id}) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

export async function selectEventRequests(
  database: Database,
  query: EventRequestQuery,
): Promise<EventRequestRow[]> {
  const conditions = requestConditions(query);
  const cursor = cursorCondition(query.cursor);
  if (cursor) conditions.push(cursor);
  const rows = await database
    .select(requestColumns())
    .from(eventRequests)
    .innerJoin(events, eq(events.id, eventRequests.eventId))
    .innerJoin(users, eq(users.id, eventRequests.userId))
    .leftJoin(assignee, eq(assignee.id, eventRequests.assignedTo))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(eventRequests.createdAt), desc(eventRequests.id))
    .limit(query.limit);
  return rows.map((row) => ({
    ...row,
    attachmentCount: Number(row.attachmentCount),
    authorTelegramUserId: row.authorTelegramUserId.toString(),
  }));
}

export async function countEventRequests(
  database: Database,
  query: EventRequestQuery,
): Promise<number> {
  const conditions = requestConditions(query);
  const [row] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(eventRequests)
    .innerJoin(events, eq(events.id, eventRequests.eventId))
    .innerJoin(users, eq(users.id, eventRequests.userId))
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return Number(row?.total ?? 0);
}

/** Счётчики для вкладок: сколько запросов ждёт разбора, сколько в работе. */
export async function eventRequestCounters(
  database: Database,
): Promise<{ all: number; new: number; in_progress: number; closed: number }> {
  const [row] = await database
    .select({
      all: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where ${eventRequests.status} = 'new')::int`,
      working: sql<number>`count(*) filter (where ${eventRequests.status} = 'in_progress')::int`,
      closed: sql<number>`count(*) filter (where ${eventRequests.status} = 'closed')::int`,
    })
    .from(eventRequests);
  return {
    all: Number(row?.all ?? 0),
    new: Number(row?.pending ?? 0),
    in_progress: Number(row?.working ?? 0),
    closed: Number(row?.closed ?? 0),
  };
}
