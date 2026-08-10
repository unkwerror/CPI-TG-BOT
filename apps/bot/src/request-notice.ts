import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  eventRequests,
  events,
  notificationDeliveries,
  roles,
  userRoles,
  users,
  type Database,
} from '@cpi/db';

export interface RequestNotice {
  requestId: string;
  eventTitle: string;
  authorName: string;
  authorUsername: string | null;
  authorPhone: string | null;
  telegramUserId: string;
  text: string;
  attachmentCount: number;
  /** Метка версии запроса: дополнение к нему должно позвать команду снова. */
  version: number;
}

export interface NoticeRecipient {
  userId: string;
  telegramUserId: string;
}

export async function loadRequestNotice(
  database: Database,
  requestId: string,
): Promise<RequestNotice | null> {
  const [row] = await database
    .select({
      requestId: eventRequests.id,
      eventTitle: events.title,
      text: eventRequests.text,
      attachments: eventRequests.attachments,
      updatedAt: eventRequests.updatedAt,
      fullName: users.fullName,
      username: users.telegramUsername,
      phone: users.phone,
      telegramUserId: users.telegramUserId,
      firstName: users.telegramFirstName,
      lastName: users.telegramLastName,
    })
    .from(eventRequests)
    .innerJoin(events, eq(events.id, eventRequests.eventId))
    .innerJoin(users, eq(users.id, eventRequests.userId))
    .where(eq(eventRequests.id, requestId))
    .limit(1);
  if (!row) return null;
  const telegramName = [row.firstName, row.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
  return {
    requestId: row.requestId,
    eventTitle: row.eventTitle,
    authorName: row.fullName?.trim() || telegramName || 'Без имени',
    authorUsername: row.username,
    authorPhone: row.phone,
    telegramUserId: row.telegramUserId.toString(),
    text: row.text,
    attachmentCount: row.attachments.length,
    version: row.updatedAt.getTime(),
  };
}

/**
 * Запрос уходит всем администраторам, у кого есть чат с ботом: отдельного списка
 * ответственных нет, а писать в чат, которого нет, Telegram не позволяет.
 */
export async function loadNoticeRecipients(database: Database): Promise<NoticeRecipient[]> {
  const rows = await database
    .selectDistinct({ userId: users.id, telegramUserId: users.telegramUserId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        inArray(roles.name, ['admin', 'superadmin']),
        isNotNull(users.botStartedAt),
        isNull(users.botBlockedAt),
        eq(users.status, 'active'),
      ),
    );
  return rows.map((row) => ({
    userId: row.userId,
    telegramUserId: row.telegramUserId.toString(),
  }));
}

export function formatRequestNotice(notice: RequestNotice): string {
  const contact = [
    notice.authorUsername ? `@${notice.authorUsername}` : null,
    notice.authorPhone,
  ].filter((part): part is string => Boolean(part));
  return [
    `Новый запрос: ${notice.eventTitle}`,
    '',
    `От: ${notice.authorName}${contact.length ? ` (${contact.join(', ')})` : ''}`,
    notice.attachmentCount > 0 ? `Вложений: ${notice.attachmentCount}` : null,
    '',
    notice.text,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Ключ включает версию запроса: дополнение обязано дойти, а не считаться дублем. */
export function noticeDeduplicationKey(notice: RequestNotice, recipientUserId: string): string {
  return `event_request.created:${notice.requestId}:${notice.version}:${recipientUserId}`;
}

export async function claimNoticeDelivery(
  database: Database,
  input: { userId: string; deduplicationKey: string },
): Promise<boolean> {
  const [existing] = await database
    .select({ deliveredAt: notificationDeliveries.deliveredAt })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.deduplicationKey, input.deduplicationKey))
    .limit(1);
  if (existing?.deliveredAt) return false;
  if (!existing) {
    await database
      .insert(notificationDeliveries)
      .values({
        userId: input.userId,
        eventType: 'event_request.created',
        deduplicationKey: input.deduplicationKey,
      })
      .onConflictDoNothing();
  }
  return true;
}

export async function markNoticeDelivered(
  database: Database,
  deduplicationKey: string,
  telegramMessageId: number,
): Promise<void> {
  await database
    .update(notificationDeliveries)
    .set({ telegramMessageId, deliveredAt: new Date(), errorMessage: null })
    .where(eq(notificationDeliveries.deduplicationKey, deduplicationKey));
}

export async function markNoticeFailed(
  database: Database,
  deduplicationKey: string,
  reason: string,
): Promise<void> {
  await database
    .update(notificationDeliveries)
    .set({ errorMessage: reason.slice(0, 2_000) })
    .where(eq(notificationDeliveries.deduplicationKey, deduplicationKey));
}
