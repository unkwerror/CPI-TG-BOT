import { createHash } from 'node:crypto';

export interface CatalystChatConfiguration {
  id: string;
  chatId: string;
  inviteUrl: string;
}

function assertChatId(chatId: string): void {
  if (!/^-\d+$/u.test(chatId)) {
    throw new Error('Catalyst Telegram chat id is invalid');
  }
}

function assertInviteUrl(inviteUrl: string): void {
  const url = new URL(inviteUrl);
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 't.me' && url.hostname !== 'telegram.me') ||
    (!url.pathname.startsWith('/+') && !url.pathname.startsWith('/joinchat/'))
  ) {
    throw new Error('Catalyst Telegram invite URL is invalid');
  }
}

export function createCatalystChatConfiguration(
  chatId: string,
  inviteUrl: string,
): CatalystChatConfiguration {
  assertChatId(chatId);
  assertInviteUrl(inviteUrl);
  const id = createHash('sha256')
    .update(chatId)
    .update('\0')
    .update(inviteUrl)
    .digest('hex')
    .slice(0, 24);
  return { id, chatId, inviteUrl };
}

export function parseCatalystChatConfiguration(serialized: string): CatalystChatConfiguration {
  const value: unknown = JSON.parse(serialized);
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { id?: unknown }).id !== 'string' ||
    typeof (value as { chatId?: unknown }).chatId !== 'string' ||
    typeof (value as { inviteUrl?: unknown }).inviteUrl !== 'string'
  ) {
    throw new Error('Catalyst Telegram chat configuration is invalid');
  }
  const stored = value as CatalystChatConfiguration;
  const validated = createCatalystChatConfiguration(stored.chatId, stored.inviteUrl);
  if (stored.id !== validated.id) {
    throw new Error('Catalyst Telegram chat configuration checksum is invalid');
  }
  return validated;
}

export function matchesCatalystChatJoinRequest(
  configuration: CatalystChatConfiguration,
  request: { chatId: string; inviteUrl?: string | undefined },
): boolean {
  return request.chatId === configuration.chatId && request.inviteUrl === configuration.inviteUrl;
}
