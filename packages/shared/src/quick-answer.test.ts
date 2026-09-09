import { describe, expect, it } from 'vitest';
import { exportCreateSchema, quickAnswerSchema } from './types';

describe('quick answer and export input', () => {
  it('trims answers and rejects blank and oversized text', () => {
    expect(quickAnswerSchema.parse({ answer: '  Ответ\n' }).answer).toBe('Ответ');
    expect(quickAnswerSchema.safeParse({ answer: ' \n\t' }).success).toBe(false);
    expect(quickAnswerSchema.safeParse({ answer: 'a'.repeat(10_001) }).success).toBe(false);
  });
  it('keeps existing event exports compatible', () => {
    expect(
      exportCreateSchema.parse({ eventId: '00000000-0000-4000-8000-000000000001', kind: 'zip' })
        .scope,
    ).toBe('event');
  });
  it('requires an event except for global XLSX exports', () => {
    expect(exportCreateSchema.safeParse({ scope: 'users', kind: 'xlsx' }).success).toBe(true);
    expect(exportCreateSchema.safeParse({ scope: 'users', kind: 'zip' }).success).toBe(false);
    expect(
      exportCreateSchema.safeParse({
        scope: 'users',
        kind: 'xlsx',
        eventId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(exportCreateSchema.safeParse({ scope: 'quick_answers', kind: 'xlsx' }).success).toBe(
      false,
    );
    expect(exportCreateSchema.safeParse({ kind: 'xlsx' }).success).toBe(false);
  });
});
