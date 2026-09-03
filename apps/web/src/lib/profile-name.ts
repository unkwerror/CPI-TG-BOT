import { isRussianNameComponent } from '@cpi/shared';

export interface ProfileNameParts {
  lastName: string;
  firstName: string;
  middleName: string;
}

function normalizeNamePart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function splitFullName(fullName: string | null | undefined): ProfileNameParts {
  const parts = normalizeNamePart(fullName ?? '')
    .split(' ')
    .filter(Boolean);
  return {
    lastName: parts[0] ?? '',
    firstName: parts[1] ?? '',
    middleName: parts.slice(2).join(' '),
  };
}

export function combineFullName(parts: ProfileNameParts): string {
  return [parts.lastName, parts.firstName, parts.middleName]
    .map(normalizeNamePart)
    .filter(Boolean)
    .join(' ');
}

const FIELD_LABELS: Record<keyof ProfileNameParts, string> = {
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
};

/**
 * Те же правила, что и на сервере: CRM заводит участника только по трём частям
 * русскими буквами. Проверка до отправки формы избавляет от неинформативной
 * ошибки валидации в ответе.
 */
export function validateFullName(parts: ProfileNameParts): string | null {
  const invalid = (Object.keys(FIELD_LABELS) as (keyof ProfileNameParts)[]).filter((field) => {
    const value = normalizeNamePart(parts[field]);
    return value.length === 0 || !isRussianNameComponent(value);
  });
  if (invalid.length === 0) return null;
  const names = invalid.map((field) => FIELD_LABELS[field].toLowerCase());
  return `Впишите ${names.join(', ')} русскими буквами, без цифр и сокращений`;
}
