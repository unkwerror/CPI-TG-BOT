import { describe, expect, it } from 'vitest';
import { richContentToText } from './rich-content';

describe('richContentToText', () => {
  it('keeps ordinary text unchanged', () => {
    expect(richContentToText('  Обычный текст  ', 'text')).toBe('Обычный текст');
  });

  it('creates a safe readable excerpt from HTML', () => {
    expect(
      richContentToText('<h2>Заголовок</h2><p>Текст&nbsp;<strong>новости</strong></p>', 'html'),
    ).toBe('Заголовок Текст новости');
  });
});
