import { describe, expect, it } from 'vitest';
import { eventListQuerySchema } from './types';

describe('eventListQuerySchema', () => {
  it('hides past events unless they are asked for', () => {
    expect(eventListQuerySchema.parse({}).includePast).toBe(false);
  });

  // Строка приходит из query-параметра, булев тип — из внутренних вызовов.
  it('accepts the flag both as a query string and as a boolean', () => {
    expect(eventListQuerySchema.parse({ includePast: 'true' }).includePast).toBe(true);
    expect(eventListQuerySchema.parse({ includePast: true }).includePast).toBe(true);
    expect(eventListQuerySchema.parse({ includePast: 'false' }).includePast).toBe(false);
  });
});
