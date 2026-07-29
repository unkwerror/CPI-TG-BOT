import { describe, expect, it } from 'vitest';
import { eventShortCodeFromTitle, eventSlugFromTitle } from './event-identifiers';

describe('event identifiers', () => {
  it('transliterates a Russian event title into readable identifiers', () => {
    const title = 'Сбор артефактов — демонстрационное мероприятие';
    expect(eventSlugFromTitle(title)).toBe('sbor-artefaktov-demonstratsionnoe-meropriyatie');
    expect(eventShortCodeFromTitle(title)).toBe('SBOR_ARTEFAKTOV_DEMONSTR');
  });

  it('normalizes punctuation and provides a safe fallback', () => {
    expect(eventSlugFromTitle('  IT & Бизнес 2026! ')).toBe('it-biznes-2026');
    expect(eventShortCodeFromTitle('Я')).toBe('EVENT');
    expect(eventSlugFromTitle('---')).toBe('event');
  });
});
