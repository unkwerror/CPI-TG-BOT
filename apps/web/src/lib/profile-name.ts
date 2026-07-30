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
