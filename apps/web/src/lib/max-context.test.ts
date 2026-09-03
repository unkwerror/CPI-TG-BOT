import { describe, expect, it } from 'vitest';
import { extractMaxInitData } from './max-context';

const initData =
  'auth_date=1787896800&query_id=max-query&user=%7B%22id%22%3A67890%7D&hash=' + 'a'.repeat(64);

describe('MAX launch context', () => {
  it('prefers signed data exposed by MAX Bridge', () => {
    expect(
      extractMaxInitData({
        sdkInitData: initData,
        hash: `#WebAppData=${encodeURIComponent('other')}`,
      }),
    ).toBe(initData);
  });

  it('reads WebAppData from the launch fragment while Bridge is loading', () => {
    expect(
      extractMaxInitData({
        hash: `#WebAppData=${encodeURIComponent(initData)}&WebAppPlatform=android`,
      }),
    ).toBe(initData);
  });

  it('rejects empty and oversized fallback values', () => {
    expect(extractMaxInitData({ hash: '#WebAppPlatform=web' })).toBeNull();
    expect(
      extractMaxInitData({
        hash: `#WebAppData=${encodeURIComponent('x'.repeat(16_385))}`,
      }),
    ).toBeNull();
  });
});
