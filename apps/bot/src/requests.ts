import { and, asc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { eventRequests, events, outboxEvents, users, type Database } from '@cpi/db';
import type { RequestDraft } from './request-flow';

/** Пауза в диалоге: черновик живёт полчаса, потом человек начинает заново. */
const DRAFT_TTL_SECONDS = 30 * 60;
/** Кнопок в списке событий: больше не помещается на экране телефона. */
const EVENT_CHOICE_LIMIT = 10;

export interface RequestEvent {
  id: string;
  title: string;
  organizer: string;
  description: string | null;
}

function draftKey(prefix: string, telegramUserId: number): string {
  return `${prefix}:request-draft:${telegramUserId}`;
}

export async function saveDraft(
  redis: Redis,
  prefix: string,
  telegramUserId: number,
  draft: RequestDraft,
): Promise<void> {
  await redis.set(draftKey(prefix, telegramUserId), JSON.stringify(draft), 'EX', DRAFT_TTL_SECONDS);
}

export async function readDraft(
  redis: Redis,
  prefix: string,
  telegramUserId: number,
): Promise<RequestDraft | null> {
  const raw = await redis.get(draftKey(prefix, telegramUserId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RequestDraft;
    return parsed.eventId && parsed.step ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearDraft(
  redis: Redis,
  prefix: string,
  telegramUserId: number,
): Promise<void> {
  await redis.del(draftKey(prefix, telegramUserId));
}

/**
 * Кнопками показываются только события с включённым приёмом запросов, и только
 * пока они не прошли: писать про завершённое мероприятие человеку незачем.
 */
export async function listRequestEvents(database: Database): Promise<RequestEvent[]> {
  return database
    .select({
      id: events.id,
      title: events.title,
      organizer: events.organizer,
      description: events.description,
    })
    .from(events)
    .where(
      and(
        isNull(events.deletedAt),
        eq(events.acceptsRequests, true),
        inArray(events.status, ['published', 'running']),
        gte(events.endsAt, new Date()),
      ),
    )
    .orderBy(asc(events.startsAt))
    .limit(EVENT_CHOICE_LIMIT);
}

export async function findRequestEvent(
  database: Database,
  eventId: string,
): Promise<RequestEvent | null> {
  const [row] = await database
    .select({
      id: events.id,
      title: events.title,
      organizer: events.organizer,
      description: events.description,
    })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),
        isNull(events.deletedAt),
        eq(events.acceptsRequests, true),
        inArray(events.status, ['published', 'running']),
        gte(events.endsAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface RequestProfileRow {
  id: string;
  fullName: string | null;
  phone: string | null;
}

export async function readProfile(
  database: Database,
  telegramUserId: number,
): Promise<RequestProfileRow | null> {
  const [row] = await database
    .select({ id: users.id, fullName: users.fullName, phone: users.phone })
    .from(users)
    .where(eq(users.telegramUserId, BigInt(telegramUserId)))
    .limit(1);
  return row ?? null;
}

/**
 * Профиль, заполненный в боте, — единственный шанс попасть в CRM для человека,
 * который никогда не открывал приложение, поэтому запись сразу переоткрывает
 * событие выгрузки: до полного ФИО CRM карточку не создавала.
 */
export async function saveProfileFields(
  database: Database,
  userId: string,
  fields: { fullName?: string; phone?: string },
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .update(users)
      .set({ ...fields, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
    await transaction
      .insert(outboxEvents)
      .values({
        type: 'crm.user.sync',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { userId },
      })
      .onConflictDoUpdate({
        target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
        set: { processedAt: null, availableAt: new Date(), attempts: 0, lastError: null },
      });
  });
}

export interface SavedRequest {
  id: string;
  appended: boolean;
}

/**
 * Второе обращение по тому же мероприятию дописывается в уже открытый запрос:
 * команде нужна одна карточка с историей, а не несколько про одно и то же.
 * Уведомление уходит через outbox, поэтому не теряется, если Telegram недоступен.
 */
export async function saveEventRequest(
  database: Database,
  input: {
    eventId: string;
    userId: string;
    text: string;
    attachments?: Array<{ fileId: string; kind: string; fileName?: string }>;
  },
): Promise<SavedRequest> {
  return database.transaction(async (transaction) => {
    const [open] = await transaction
      .select({ id: eventRequests.id, text: eventRequests.text })
      .from(eventRequests)
      .where(
        and(
          eq(eventRequests.eventId, input.eventId),
          eq(eventRequests.userId, input.userId),
          ne(eventRequests.status, 'closed'),
        ),
      )
      .limit(1);

    const attachments = input.attachments ?? [];
    if (open) {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      await transaction
        .update(eventRequests)
        .set({
          text: `${open.text}\n\n— дополнение ${stamp} —\n${input.text}`,
          attachments: attachments.length
            ? sql`${eventRequests.attachments} || ${JSON.stringify(attachments)}::jsonb`
            : undefined,
          updatedAt: new Date(),
        })
        .where(eq(eventRequests.id, open.id));
      await enqueueRequestNotice(transaction, open.id);
      return { id: open.id, appended: true };
    }

    const [created] = await transaction
      .insert(eventRequests)
      .values({
        eventId: input.eventId,
        userId: input.userId,
        text: input.text,
        attachments,
      })
      .returning({ id: eventRequests.id });
    if (!created) throw new Error('Event request was not stored');
    await enqueueRequestNotice(transaction, created.id);
    return { id: created.id, appended: false };
  });
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function enqueueRequestNotice(transaction: Transaction, requestId: string): Promise<void> {
  await transaction
    .insert(outboxEvents)
    .values({
      type: 'event_request.created',
      aggregateType: 'event_request',
      aggregateId: requestId,
      payload: { requestId },
    })
    .onConflictDoUpdate({
      target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
      // Дополнение к запросу — тоже повод позвать команду ещё раз.
      set: { processedAt: null, availableAt: new Date(), attempts: 0, lastError: null },
    });
}
