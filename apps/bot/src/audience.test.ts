import { describe, expect, it } from 'vitest';
import { isUnreachableRecipientError } from './audience';

describe('isUnreachableRecipientError', () => {
  it('recognizes the refusals that mean the chat is gone', () => {
    expect(isUnreachableRecipientError('Forbidden: bot was blocked by the user')).toBe(true);
    expect(isUnreachableRecipientError('Forbidden: user is deactivated')).toBe(true);
    expect(isUnreachableRecipientError('Bad Request: chat not found')).toBe(true);
  });

  it('leaves transient failures alone so they keep retrying', () => {
    expect(isUnreachableRecipientError('Too Many Requests: retry after 5')).toBe(false);
    expect(isUnreachableRecipientError('Internal Server Error')).toBe(false);
    expect(isUnreachableRecipientError('fetch failed')).toBe(false);
  });
});
