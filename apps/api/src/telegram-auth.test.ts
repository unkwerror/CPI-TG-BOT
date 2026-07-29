import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTelegramInitData } from './telegram-auth';

const botToken = '123456:TEST_BOT_TOKEN';

function signedInitData(authDate: number, userId = 123_456_789): string {
  const parameters = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAEAAAE',
    user: JSON.stringify({
      id: userId,
      first_name: 'Иван',
      last_name: 'Петров',
      username: 'ivan',
      language_code: 'ru',
    }),
  });
  const check = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  parameters.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return parameters.toString();
}

describe('Telegram initData validation', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');
  const authDate = Math.floor(now.getTime() / 1000);

  it('accepts authentic, fresh initData', () => {
    const result = verifyTelegramInitData(signedInitData(authDate), botToken, {
      now,
      maxAgeSeconds: 300,
    });
    expect(result.user.id).toBe(123_456_789n);
    expect(result.user.firstName).toBe('Иван');
  });

  it('rejects tampering', () => {
    const data = signedInitData(authDate).replace('ivan', 'petr');
    expect(() => verifyTelegramInitData(data, botToken, { now })).toThrow(/подпись/i);
  });

  it('rejects expired auth_date', () => {
    expect(() =>
      verifyTelegramInitData(signedInitData(authDate - 301), botToken, {
        now,
        maxAgeSeconds: 300,
      }),
    ).toThrow(/устарела/i);
  });
});
