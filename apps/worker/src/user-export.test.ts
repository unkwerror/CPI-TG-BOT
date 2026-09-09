import { describe, expect, it } from 'vitest';
import { chatMembership, conversionSheets, telegramRead, type ConversionUser } from './user-export';

function user(patch: Partial<ConversionUser> = {}): ConversionUser {
  return {
    id: 'one',
    fullName: 'Иванов Иван Иванович',
    messengerName: '',
    telegramId: '123',
    telegramUsername: 'ivan',
    maxId: null,
    botUsed: true,
    botEvidence: 'Запуск',
    appOpened: true,
    appEvidence: 'Вход',
    firstBotStartedAt: null,
    firstAppOpenedAt: null,
    leaderId: 123,
    leaderLinkedAt: new Date(),
    inChat: true,
    chatCheckedAt: new Date(),
    chatError: null,
    status: 'active',
    canMessageTelegram: true,
    canMessageMax: null,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    ...patch,
  };
}

describe('user conversion export', () => {
  it.each(['member', 'administrator', 'creator'])('recognizes %s membership', (status) => {
    expect(chatMembership({ status })).toBe(true);
  });
  it('handles restricted, departed and unknown members without guessing', () => {
    expect(chatMembership({ status: 'restricted', is_member: true })).toBe(true);
    expect(chatMembership({ status: 'restricted', is_member: false })).toBe(false);
    expect(chatMembership({ status: 'restricted' })).toBeNull();
    expect(chatMembership({ status: 'left' })).toBe(false);
    expect(chatMembership({ status: 'kicked' })).toBe(false);
    expect(chatMembership({ status: 'new-status' })).toBeNull();
  });
  it('uses Telegram bot users as the chat denominator and keeps unknown results explicit', () => {
    const sheets = conversionSheets(
      [
        user(),
        user({ id: 'two', inChat: null, leaderId: null }),
        user({ id: 'max-only', telegramId: null, maxId: '789', inChat: null }),
        user({ id: 'app-only', botUsed: false, inChat: false, leaderId: null }),
      ],
      20,
      new Date('2026-09-09T00:00:00Z'),
      'Проверка',
    );
    const summary = sheets[1]!.rows as Array<{
      metric: string;
      count: number;
      denominator: number;
      percent: number;
    }>;
    expect(summary.find((row) => row.metric === 'Telegram-бот → чат Каталиста')).toMatchObject({
      count: 1,
      denominator: 2,
      percent: 50,
    });
    expect(summary.find((row) => row.metric === 'Бот → Leader ID')).toMatchObject({
      count: 2,
      denominator: 3,
      percent: 66.67,
    });
    expect(summary.find((row) => row.metric === 'Не удалось проверить членство')?.count).toBe(1);
    expect(sheets[0]!.rows[1]).toMatchObject({ inChat: 'Неизвестно' });
    expect(sheets[0]!.rows[2]).toMatchObject({ inChat: 'Нет Telegram' });
    expect(sheets[0]!.rows[3]).toMatchObject({ botUsed: 'Нет данных' });
  });
  it('leaves zero and unknown denominators blank', () => {
    const sheets = conversionSheets([], null, new Date(), 'Нет чата');
    expect(
      sheets[1]!.rows.every((row) => (row as { percent: number | null }).percent === null),
    ).toBe(true);
  });
  it('never includes token-bearing fetch errors in the report', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('https://api.telegram.org/botSECRET/getMe');
    };
    await expect(telegramRead('SECRET', 'getMe', {}, fetcher)).rejects.toThrow(
      'Telegram: соединение недоступно',
    );
  });
  it('keeps rate-limit and access errors distinct from a negative membership result', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error_code: 429 }), { status: 429 });
    await expect(telegramRead('SECRET', 'getChatMember', {}, fetcher)).rejects.toThrow(
      'Telegram: ошибка 429',
    );
  });
});
