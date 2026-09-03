import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '@cpi/shared';
import { verifyMaxInitData } from './max-auth';

const token = 'max-test-token-that-is-long-enough';
const now = new Date('2026-08-25T07:00:00.000Z');

function signedMaxInitData(values: Record<string, string>, tokenValue = token): string {
  const launchParameters = Object.entries(values)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(tokenValue).digest();
  const hash = createHmac('sha256', secret).update(launchParameters).digest('hex');
  return new URLSearchParams({ ...values, hash }).toString();
}

describe('verifyMaxInitData', () => {
  it('verifies MAX WebAppData and returns normalized user data', () => {
    const initData = signedMaxInitData({
      auth_date: String(Math.floor(now.getTime() / 1_000)),
      query_id: 'query-1',
      start_param: 'event_science-picnic',
      user: JSON.stringify({
        id: 67890,
        first_name: 'Антон',
        last_name: 'Куракин',
        username: 'kurakin',
        language_code: 'ru',
      }),
    });

    expect(verifyMaxInitData(initData, token, { now })).toMatchObject({
      user: {
        id: 67890n,
        firstName: 'Антон',
        lastName: 'Куракин',
        username: 'kurakin',
        languageCode: 'ru',
      },
      queryId: 'query-1',
      startParam: 'event_science-picnic',
    });
  });

  it('rejects tampered and duplicate parameters', () => {
    const valid = signedMaxInitData({
      auth_date: String(Math.floor(now.getTime() / 1_000)),
      user: JSON.stringify({ id: 67890, first_name: 'Антон' }),
    });
    const tampered = new URLSearchParams(valid);
    tampered.set('user', JSON.stringify({ id: 67890, first_name: 'Иван' }));
    expect(() => verifyMaxInitData(tampered.toString(), token, { now })).toThrowError(AppError);
    expect(() => verifyMaxInitData(`${valid}&auth_date=1`, token, { now })).toThrowError(
      /неоднозначные/u,
    );
  });
});
