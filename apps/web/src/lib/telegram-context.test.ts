import { describe, expect, it } from 'vitest';
import { extractTelegramInitData } from './telegram-context';

const initData = 'query_id=AAE123&user=%7B%22id%22%3A982615235%7D&auth_date=1785418128&hash=abc';

describe('Telegram launch context', () => {
  it('prefers initData exposed by the Telegram SDK', () => {
    expect(
      extractTelegramInitData({
        sdkInitData: initData,
        hash: `#tgWebAppData=${encodeURIComponent('other')}`,
      }),
    ).toBe(initData);
  });

  it('reads initData from Telegram launch hash when the SDK is delayed', () => {
    expect(
      extractTelegramInitData({
        hash: `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=9.1`,
      }),
    ).toBe(initData);
  });

  it('supports Telegram hashes containing a path', () => {
    expect(
      extractTelegramInitData({
        hash: `#/materials?tgWebAppData=${encodeURIComponent(initData)}&tgWebAppPlatform=android`,
      }),
    ).toBe(initData);
  });

  it('uses the storage format maintained by the official Telegram SDK', () => {
    expect(
      extractTelegramInitData({
        storedParams: JSON.stringify({ tgWebAppData: initData }),
      }),
    ).toBe(initData);
  });

  it('rejects missing, malformed, and oversized fallback values', () => {
    expect(extractTelegramInitData({ hash: '#tgWebAppVersion=9.1' })).toBeNull();
    expect(extractTelegramInitData({ storedParams: '{' })).toBeNull();
    expect(
      extractTelegramInitData({
        hash: `#tgWebAppData=${encodeURIComponent('x'.repeat(16_385))}`,
      }),
    ).toBeNull();
  });
});
