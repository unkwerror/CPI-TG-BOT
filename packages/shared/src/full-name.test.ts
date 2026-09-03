import { describe, expect, it } from 'vitest';
import { isCrmReadyFullName, parseRussianFullName } from './full-name';

describe('CRM-compatible full name', () => {
  it('splits a normalized Russian full name into three parts', () => {
    expect(parseRussianFullName('  Иванов   Иван  Иванович ')).toEqual({
      lastName: 'Иванов',
      firstName: 'Иван',
      patronymic: 'Иванович',
      fullName: 'Иванов Иван Иванович',
    });
  });

  it('keeps hyphenated components', () => {
    expect(parseRussianFullName('Петрова-Водкина Анна Ильинична')?.lastName).toBe(
      'Петрова-Водкина',
    );
  });

  it.each([
    ['одно имя', 'Павел'],
    ['без отчества', 'Иванов Иван'],
    ['латиница', 'Ivanov Ivan Ivanovich'],
    ['смешанные алфавиты', 'Иванов Ivan Иванович'],
    ['инициалы', 'Иванов И. И.'],
    ['лишняя часть', 'Иванов Иван Иванович Оглы'],
    ['цифры', 'Иванов Иван Иванович2'],
  ])('отклоняет %s', (_case, value) => {
    expect(parseRussianFullName(value)).toBeNull();
    expect(isCrmReadyFullName(value)).toBe(false);
  });

  it('treats a missing name as incomplete', () => {
    expect(isCrmReadyFullName(null)).toBe(false);
    expect(isCrmReadyFullName(undefined)).toBe(false);
  });
});
