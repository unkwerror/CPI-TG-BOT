import { describe, expect, it } from 'vitest';
import { isPermanentTelegramRecipientError } from './delivery-errors';

describe('isPermanentTelegramRecipientError', () => {
  it('recognizes a Telegram 403 as a permanent recipient failure', () => {
    expect(
      isPermanentTelegramRecipientError({
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      }),
    ).toBe(true);
  });

  it('keeps rate limits and network errors retryable', () => {
    expect(isPermanentTelegramRecipientError({ error_code: 429 })).toBe(false);
    expect(isPermanentTelegramRecipientError(new Error('network failed'))).toBe(false);
  });
});
