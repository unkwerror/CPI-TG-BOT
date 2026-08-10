import { campaignReplyActions, type CampaignReplyAction } from '@cpi/shared';

const UUID_LENGTH = 36;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface CampaignReplyReference {
  recipientId: string;
  action: CampaignReplyAction;
}

function toReference(recipientId: string, action: string): CampaignReplyReference | null {
  if (!uuidPattern.test(recipientId)) return null;
  const normalized = action.trim().toUpperCase();
  const known = campaignReplyActions.find((candidate) => candidate === normalized);
  if (!known) return null;
  return { recipientId: recipientId.toLowerCase(), action: known };
}

/**
 * Кнопка отклика из письма приходит как deep link `/start cmp_<uuid>_<ACTION>`.
 * Действие само содержит подчёркивание (`MORE_INFO`), поэтому разделитель ищется
 * по длине UUID, а не последним подчёркиванием в строке.
 */
export function parseCampaignStartPayload(
  payload: string | undefined | null,
): CampaignReplyReference | null {
  if (!payload) return null;
  const trimmed = payload.trim();
  if (!trimmed.startsWith('cmp_')) return null;
  const rest = trimmed.slice(4);
  if (rest.charAt(UUID_LENGTH) !== '_') return null;
  return toReference(rest.slice(0, UUID_LENGTH), rest.slice(UUID_LENGTH + 1));
}

/** Кнопка под сообщением рассылки приходит как callback_data `cmp:<uuid>:<ACTION>`. */
export function parseCampaignCallbackData(
  data: string | undefined | null,
): CampaignReplyReference | null {
  if (!data) return null;
  const trimmed = data.trim();
  if (!trimmed.startsWith('cmp:')) return null;
  const rest = trimmed.slice(4);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  return toReference(rest.slice(0, separator), rest.slice(separator + 1));
}

/** Полезная нагрузка `/start` мероприятия: `event_<КОД>` либо сам код. */
export function parseEventStartPayload(payload: string | undefined | null): string | null {
  if (!payload) return null;
  const trimmed = payload.trim();
  if (!trimmed || trimmed.startsWith('cmp_')) return null;
  const code = trimmed.startsWith('event_') ? trimmed.slice('event_'.length) : trimmed;
  return code || null;
}

export const CAMPAIGN_REPLY_MESSAGES: Readonly<Record<CampaignReplyAction, string>> = {
  INTERESTED: 'Спасибо, отметили ваш интерес — организаторы свяжутся с вами.',
  MORE_INFO: 'Принято: пришлём подробности в этот чат.',
  UNSUBSCRIBED: 'Вы отписались от рассылки. Мы больше не будем присылать такие сообщения.',
};
