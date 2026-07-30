import { describe, expect, it } from 'vitest';
import { profileUpdateSchema } from './types';

const baseProfile = {
  organization: null,
  position: null,
  phone: null,
  consent: true as const,
};

describe('profile registration validation', () => {
  it('accepts and normalizes surname, name, and patronymic', () => {
    const result = profileUpdateSchema.parse({
      ...baseProfile,
      fullName: '  Иванов   Иван   Иванович ',
    });

    expect(result.fullName).toBe('Иванов Иван Иванович');
  });

  it('requires all three full-name parts', () => {
    expect(() =>
      profileUpdateSchema.parse({
        ...baseProfile,
        fullName: 'Иванов Иван',
      }),
    ).toThrow(/отчество/i);
  });
});
