import { eq, sql } from 'drizzle-orm';
import { outboxEvents, users, type Database } from '@cpi/db';
import type { CampaignReplyAction } from '@cpi/shared';

export interface TelegramSender {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Любое обращение к боту заводит участника: до этого человек попадал в базу
 * только входом в Mini App, поэтому нажавшие «Старт» нигде не значились и
 * рассылка их не видела. Запись сразу ставится в очередь на выгрузку в CRM —
 * без карточки участника рассылка в CRM до этого адресата не дотянется.
 */
export async function ensureBotUser(
  database: Database,
  sender: TelegramSender,
): Promise<string | null> {
  const now = new Date();
  return database.transaction(async (transaction) => {
    const [row] = await transaction
      .insert(users)
      .values({
        telegramUserId: BigInt(sender.id),
        telegramUsername: sender.username ?? null,
        telegramFirstName: sender.first_name ?? null,
        telegramLastName: sender.last_name ?? null,
        telegramLanguageCode: sender.language_code ?? null,
        source: 'bot',
        botStartedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: users.telegramUserId,
        set: {
          telegramUsername: sender.username ?? null,
          telegramFirstName: sender.first_name ?? null,
          telegramLastName: sender.last_name ?? null,
          telegramLanguageCode: sender.language_code ?? null,
          // Первое обращение не переписывается: важна самая ранняя дата.
          botStartedAt: sql`coalesce(${users.botStartedAt}, ${now})`,
          // Человек снова пишет боту, значит блокировка снята.
          botBlockedAt: null,
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .returning({
        id: users.id,
        crmPersonId: users.crmPersonId,
        crmSyncError: users.crmSyncError,
      });
    if (!row) return null;
    // Отказ CRM по составу данных не изменится от нового сообщения боту, поэтому
    // повторная попытка нужна только после заполнения профиля или по кнопке в
    // админке — иначе каждое сообщение дёргало бы CRM впустую.
    if (!row.crmPersonId && !row.crmSyncError) await enqueueCrmUserSync(transaction, row.id);
    return row.id;
  });
}

async function enqueueCrmUserSync(transaction: Transaction, userId: string): Promise<void> {
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
      // Профиль мог измениться, поэтому уже обработанное событие переоткрывается.
      set: { processedAt: null, availableAt: new Date(), attempts: 0, lastError: null },
    });
}

/**
 * Отклик на рассылку уходит в CRM через outbox, а не прямым запросом: нажатие
 * нельзя терять из-за недоступности CRM в эту секунду, а повторы уже умеет
 * делать диспетчер. Ключ включает действие — человек может нажать и «интересно»,
 * и «отписаться».
 */
export async function recordCampaignReply(
  database: Database,
  reply: { recipientId: string; action: CampaignReplyAction },
): Promise<void> {
  await database
    .insert(outboxEvents)
    .values({
      type: 'crm.campaign.reply',
      aggregateType: 'campaign_recipient',
      aggregateId: `${reply.recipientId}:${reply.action}`,
      payload: { recipientId: reply.recipientId, action: reply.action },
    })
    .onConflictDoNothing();
}

const unreachableMarkers = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  "bot can't initiate conversation",
];

/** Такие отказы Telegram означают, что адресат недостижим до нового «Старта». */
export function isUnreachableRecipientError(message: string): boolean {
  const normalized = message.toLowerCase();
  return unreachableMarkers.some((marker) => normalized.includes(marker));
}

export async function markBotBlocked(database: Database, userId: string): Promise<void> {
  await database
    .update(users)
    .set({ botBlockedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}
