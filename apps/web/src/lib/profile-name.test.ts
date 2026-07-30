import { describe, expect, it } from 'vitest';
import { combineFullName, splitFullName } from './profile-name';

describe('profile name fields', () => {
  it('splits a stored full name into registration fields', () => {
    expect(splitFullName('Иванов Иван Иванович')).toEqual({
      lastName: 'Иванов',
      firstName: 'Иван',
      middleName: 'Иванович',
    });
  });

  it('keeps compound patronymics and normalizes whitespace', () => {
    expect(splitFullName('  Алиев   Рустам   Мехмет оглы ')).toEqual({
      lastName: 'Алиев',
      firstName: 'Рустам',
      middleName: 'Мехмет оглы',
    });
  });

  it('combines the three required fields in registry order', () => {
    expect(
      combineFullName({
        lastName: '  Иванов ',
        firstName: ' Иван ',
        middleName: ' Иванович ',
      }),
    ).toBe('Иванов Иван Иванович');
  });
});
