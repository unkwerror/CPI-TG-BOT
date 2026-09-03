import { describe, expect, it } from 'vitest';
import { assertFeedActionSelection, isSafeFeedActionUrl } from './feed-action';

describe('feed action validation', () => {
  it('accepts no action or exactly one internal entity action', () => {
    expect(() => assertFeedActionSelection({})).not.toThrow();
    expect(() =>
      assertFeedActionSelection({ eventId: '4b6970c4-31b6-41d7-8daa-f56b41a53511' }),
    ).not.toThrow();
    expect(() =>
      assertFeedActionSelection({ productId: '5d6970c4-31b6-41d7-8daa-f56b41a53512' }),
    ).not.toThrow();
  });

  it.each(['https://example.org/path', 'http://localhost:3000/path'])('accepts %s', (url) => {
    expect(isSafeFeedActionUrl(url)).toBe(true);
    expect(() => assertFeedActionSelection({ ctaUrl: url })).not.toThrow();
  });

  it.each([
    '/events/example',
    'javascript:alert(1)',
    'data:text/html,test',
    'mailto:test@example.org',
    'https://user:password@example.org/path',
    'not a url',
  ])('rejects unsupported CTA URL %s', (url) => {
    expect(isSafeFeedActionUrl(url)).toBe(false);
    expect(() => assertFeedActionSelection({ ctaUrl: url })).toThrow(
      'CTA должна быть полной http(s)-ссылкой без логина и пароля',
    );
  });

  it('rejects conflicting external, event, and product actions', () => {
    expect(() =>
      assertFeedActionSelection({
        ctaUrl: 'https://example.org',
        eventId: '4b6970c4-31b6-41d7-8daa-f56b41a53511',
      }),
    ).toThrow('Выберите одно действие');
    expect(() =>
      assertFeedActionSelection({
        eventId: '4b6970c4-31b6-41d7-8daa-f56b41a53511',
        productId: '5d6970c4-31b6-41d7-8daa-f56b41a53512',
      }),
    ).toThrow('Выберите одно действие');
  });
});
