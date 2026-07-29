import { describe, expect, it } from 'vitest';
import { addHoursToNovosibirskInput, fromNovosibirskInput, toNovosibirskInput } from './dates';

describe('Novosibirsk date conversion', () => {
  it('converts between UTC and the fixed event input timezone', () => {
    expect(toNovosibirskInput('2026-07-29T12:00:00.000Z')).toBe('2026-07-29T19:00');
    expect(fromNovosibirskInput('2026-07-29T19:00')).toBe('2026-07-29T12:00:00.000Z');
  });

  it('keeps date ranges predictable when adding hours', () => {
    expect(addHoursToNovosibirskInput('2026-07-29T23:30', 2)).toBe('2026-07-30T01:30');
  });
});
