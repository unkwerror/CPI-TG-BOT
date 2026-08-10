import { and, desc, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { users, type Database } from '@cpi/db';
import { decodeKeysetCursor, type AudienceFilter } from '@cpi/shared';

export interface AudienceQuery {
  q?: string | undefined;
  filter: AudienceFilter;
  eventId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface AudienceRow {
  id: string;
  createdAt: Date;
  telegramUserId: string;
  telegramUsername: string | null;
  telegramName: string | null;
  fullName: string | null;
  phone: string | null;
  organization: string | null;
  position: string | null;
  source: string;
  status: string;
  botStartedAt: Date | null;
  botBlockedAt: Date | null;
  consentAt: Date | null;
  lastSeenAt: Date;
  crmPersonId: string | null;
  crmSyncedAt: Date | null;
  crmSyncError: string | null;
  eventCount: number;
  submissionCount: number;
  artifactCount: number;
  totalBytes: number;
  joinedAt: Date | null;
  lastSubmissionAt: Date | null;
}

/**
 * Счётчики берутся подзапросами, а не соединениями: при join сразу и отправок, и
 * файлов строки размножаются, и `sum` по такому набору занижает объём, потому что
 * `distinct` склеивает файлы одинакового размера.
 *
 * Таблицы в подзапросах получают псевдоним, а внешняя ссылка пишется как
 * `users.id` текстом: подстановка столбца через `${...}` разворачивается в имя без
 * таблицы, и внутри подзапроса такое имя связывается с его собственной таблицей —
 * условие тихо превращается в `artifacts.user_id = artifacts.id` и не находит ничего.
 */
function audienceColumns(eventId?: string) {
  const submissionScope = eventId ? sql`and entry.event_id = ${eventId}::uuid` : sql``;
  const artifactScope = eventId ? sql`and file.event_id = ${eventId}::uuid` : sql``;
  const participantScope = eventId ? sql`and participation.event_id = ${eventId}::uuid` : sql``;
  return {
    id: users.id,
    createdAt: users.createdAt,
    telegramUserId: users.telegramUserId,
    telegramUsername: users.telegramUsername,
    telegramName: sql<string | null>`nullif(trim(concat_ws(' ',
      ${users.telegramFirstName}, ${users.telegramLastName})), '')`,
    fullName: users.fullName,
    phone: users.phone,
    organization: users.organization,
    position: users.position,
    source: users.source,
    status: users.status,
    botStartedAt: users.botStartedAt,
    botBlockedAt: users.botBlockedAt,
    consentAt: users.consentAt,
    lastSeenAt: users.lastSeenAt,
    crmPersonId: users.crmPersonId,
    crmSyncedAt: users.crmSyncedAt,
    crmSyncError: users.crmSyncError,
    eventCount: sql<number>`(select count(*) from event_participants participation
      where participation.user_id = users.id ${participantScope})`,
    submissionCount: sql<number>`(select count(*) from submissions entry
      where entry.user_id = users.id and entry.deleted_at is null ${submissionScope})`,
    artifactCount: sql<number>`(select count(*) from artifacts file
      where file.user_id = users.id and file.deleted_at is null ${artifactScope})`,
    totalBytes: sql<number>`(select coalesce(sum(file.size_bytes), 0) from artifacts file
      where file.user_id = users.id and file.deleted_at is null ${artifactScope})`,
    joinedAt: sql<Date | null>`(select min(participation.joined_at)
      from event_participants participation
      where participation.user_id = users.id ${participantScope})`,
    lastSubmissionAt: sql<Date | null>`(select max(participation.last_submission_at)
      from event_participants participation
      where participation.user_id = users.id ${participantScope})`,
  };
}

export function audienceConditions(query: AudienceQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.eventId) {
    conditions.push(
      sql`exists (select 1 from event_participants participation
        where participation.user_id = users.id
          and participation.event_id = ${query.eventId}::uuid)`,
    );
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    // Телефон в базе записан как его ввёл человек, поэтому цифры запроса
    // сравниваются с номером, из которого убраны пробелы, скобки и дефисы.
    const digits = query.q.replace(/\D/gu, '');
    const digitPattern = `%${digits}%`;
    const matches = or(
      ilike(users.fullName, pattern),
      ilike(users.telegramUsername, pattern),
      ilike(users.telegramFirstName, pattern),
      ilike(users.telegramLastName, pattern),
      ilike(users.organization, pattern),
      ilike(users.phone, pattern),
      digits
        ? sql`regexp_replace(coalesce(users.phone, ''), '[^0-9]', '', 'g') like ${digitPattern}`
        : undefined,
      digits ? sql`users.telegram_user_id::text like ${digitPattern}` : undefined,
    );
    if (matches) conditions.push(matches);
  }
  if (query.filter === 'bot') conditions.push(isNotNull(users.botStartedAt));
  if (query.filter === 'unregistered') conditions.push(isNull(users.fullName));
  if (query.filter === 'registered') conditions.push(isNotNull(users.fullName));
  if (query.filter === 'crm_pending') conditions.push(isNull(users.crmPersonId));
  if (query.filter === 'participants') {
    conditions.push(
      sql`exists (select 1 from event_participants participation
        where participation.user_id = users.id)`,
    );
  }
  return conditions;
}

/** Курсор сравнивается парой «дата, id»: сортировка идёт по дате появления. */
function cursorCondition(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const position = decodeKeysetCursor(cursor);
  if (!position) return undefined;
  return sql`(${users.createdAt}, ${users.id}) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

export async function selectAudience(
  database: Database,
  query: AudienceQuery,
): Promise<AudienceRow[]> {
  const conditions = audienceConditions(query);
  const cursor = cursorCondition(query.cursor);
  if (cursor) conditions.push(cursor);
  const rows = await database
    .select(audienceColumns(query.eventId))
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(query.limit);
  return rows.map((row) => ({
    ...row,
    telegramUserId: row.telegramUserId.toString(),
    eventCount: Number(row.eventCount),
    submissionCount: Number(row.submissionCount),
    artifactCount: Number(row.artifactCount),
    totalBytes: Number(row.totalBytes),
  }));
}

/** Верхняя граница выгрузки: сотни тысяч строк в CSV всё равно не открыть. */
export const AUDIENCE_EXPORT_LIMIT = 20_000;

export const AUDIENCE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  bot: 'Бот',
  miniapp: 'Приложение',
  import: 'Импорт',
};

export interface AudienceCounters {
  all: number;
  bot: number;
  unregistered: number;
  registered: number;
  participants: number;
  crmPending: number;
  botBlocked: number;
}

export async function audienceCounters(database: Database): Promise<AudienceCounters> {
  const [row] = await database
    .select({
      all: sql<number>`count(*)`,
      bot: sql<number>`count(*) filter (where ${users.botStartedAt} is not null)`,
      unregistered: sql<number>`count(*) filter (where ${users.fullName} is null)`,
      registered: sql<number>`count(*) filter (where ${users.fullName} is not null)`,
      participants: sql<number>`count(*) filter (where exists (
        select 1 from event_participants participation
         where participation.user_id = users.id))`,
      crmPending: sql<number>`count(*) filter (where ${users.crmPersonId} is null)`,
      botBlocked: sql<number>`count(*) filter (where ${users.botBlockedAt} is not null)`,
    })
    .from(users);
  return {
    all: Number(row?.all ?? 0),
    bot: Number(row?.bot ?? 0),
    unregistered: Number(row?.unregistered ?? 0),
    registered: Number(row?.registered ?? 0),
    participants: Number(row?.participants ?? 0),
    crmPending: Number(row?.crmPending ?? 0),
    botBlocked: Number(row?.botBlocked ?? 0),
  };
}

export async function countAudience(database: Database, query: AudienceQuery): Promise<number> {
  const conditions = audienceConditions(query);
  const [row] = await database
    .select({ total: sql<number>`count(*)` })
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return Number(row?.total ?? 0);
}
