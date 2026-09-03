import { describe, expect, it } from 'vitest';
import {
  createCatalystChatConfiguration,
  matchesTrustedCatalystChatJoinRequest,
} from './catalyst-chat';

const configured = createCatalystChatConfiguration(
  '-1001234567890',
  'https://t.me/+ConfiguredInvite',
);
const fallback = {
  chatId: '-1009999999999',
  inviteUrl: 'https://t.me/+LegacyInvite',
};

describe('matchesTrustedCatalystChatJoinRequest', () => {
  it('matches the invite link created by the bot for the configured chat', () => {
    expect(
      matchesTrustedCatalystChatJoinRequest(configured, fallback, {
        chatId: configured.chatId,
        inviteUrl: configured.inviteUrl,
      }),
    ).toBe(true);
  });

  it('does not use the fallback after a chat was configured', () => {
    expect(
      matchesTrustedCatalystChatJoinRequest(configured, fallback, {
        chatId: fallback.chatId,
        inviteUrl: fallback.inviteUrl,
      }),
    ).toBe(false);
  });

  it('matches the trusted fallback when no runtime chat is configured', () => {
    expect(
      matchesTrustedCatalystChatJoinRequest(null, fallback, {
        chatId: fallback.chatId,
        inviteUrl: fallback.inviteUrl,
      }),
    ).toBe(true);
  });

  it('rejects a fallback request from a different chat', () => {
    expect(
      matchesTrustedCatalystChatJoinRequest(null, fallback, {
        chatId: '-1001111111111',
        inviteUrl: fallback.inviteUrl,
      }),
    ).toBe(false);
  });

  it('rejects missing and unrelated invite links', () => {
    expect(
      matchesTrustedCatalystChatJoinRequest(
        null,
        { inviteUrl: fallback.inviteUrl },
        {
          chatId: fallback.chatId,
          inviteUrl: 'https://t.me/+UntrustedInvite',
        },
      ),
    ).toBe(false);
  });
});
