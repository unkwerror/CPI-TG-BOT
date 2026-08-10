import type { ArtifactStatus, EventStatus, RoleName } from './types';

const dangerousExtensions = new Set([
  'apk',
  'app',
  'bat',
  'bin',
  'cmd',
  'com',
  'cpl',
  'dll',
  'dmg',
  'exe',
  'gadget',
  'hta',
  'inf',
  'ins',
  'iso',
  'jar',
  'js',
  'jse',
  'lnk',
  'msi',
  'msp',
  'mst',
  'pif',
  'ps1',
  'reg',
  'scr',
  'sh',
  'sys',
  'vbe',
  'vbs',
  'ws',
  'wsf',
]);

export function extensionOf(fileName: string): string {
  const normalized = fileName.trim();
  const index = normalized.lastIndexOf('.');
  return index > 0 && index < normalized.length - 1
    ? normalized.slice(index + 1).toLocaleLowerCase('en-US')
    : '';
}

export function sanitizeDisplayName(fileName: string, maxLength = 240): string {
  const normalized = fileName.normalize('NFKC');
  const withoutUnsafeCharacters = [...normalized]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 || '<>:"/\\|?*'.includes(character) ? '_' : character;
    })
    .join('');
  const clean = withoutUnsafeCharacters.replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
  return (clean || 'file').slice(0, maxLength);
}

export function safeZipSegment(value: string, fallback = 'Без_названия'): string {
  const clean = sanitizeDisplayName(value).replace(/\s+/g, '_').replace(/\.+$/g, '').slice(0, 100);
  return clean || fallback;
}

export interface FilePolicyInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  maxFileSizeBytes: number;
  allowedMimeTypes?: string[];
  blockedExtensions?: string[];
}

export type FilePolicyResult =
  | { allowed: true; extension: string; requiresQuarantine: boolean }
  | { allowed: false; code: 'FILE_TOO_LARGE' | 'FILE_TYPE_NOT_ALLOWED'; reason: string };

export function evaluateFilePolicy(input: FilePolicyInput): FilePolicyResult {
  if (input.sizeBytes > input.maxFileSizeBytes) {
    return {
      allowed: false,
      code: 'FILE_TOO_LARGE',
      reason: `Размер файла превышает лимит ${input.maxFileSizeBytes} байт`,
    };
  }
  const extension = extensionOf(input.fileName);
  const blocked = new Set(
    (input.blockedExtensions ?? []).map((item) => item.replace(/^\./, '').toLowerCase()),
  );
  if (extension && blocked.has(extension)) {
    return {
      allowed: false,
      code: 'FILE_TYPE_NOT_ALLOWED',
      reason: `Файлы .${extension} запрещены для этого мероприятия`,
    };
  }
  const allowedMimeTypes = input.allowedMimeTypes ?? [];
  if (
    allowedMimeTypes.length > 0 &&
    !allowedMimeTypes.some(
      (allowed) =>
        allowed === input.mimeType ||
        (allowed.endsWith('/*') && input.mimeType.startsWith(allowed.slice(0, -1))),
    )
  ) {
    return {
      allowed: false,
      code: 'FILE_TYPE_NOT_ALLOWED',
      reason: `Тип ${input.mimeType} не разрешён для этого мероприятия`,
    };
  }
  return {
    allowed: true,
    extension,
    requiresQuarantine: dangerousExtensions.has(extension),
  };
}

export function eventAcceptsUploads(
  event: {
    status: EventStatus;
    acceptUploadsFrom: Date;
    acceptUploadsUntil: Date;
    deletedAt?: Date | null;
  },
  now = new Date(),
): boolean {
  return (
    event.deletedAt == null &&
    ['published', 'running'].includes(event.status) &&
    now >= event.acceptUploadsFrom &&
    now <= event.acceptUploadsUntil
  );
}

export function canAccessArtifact(input: {
  currentUserId: string;
  artifactOwnerId: string;
  roles: RoleName[];
  status: ArtifactStatus;
}): boolean {
  if (input.status === 'deleted') return false;
  return (
    input.currentUserId === input.artifactOwnerId ||
    input.roles.includes('admin') ||
    input.roles.includes('superadmin')
  );
}

export function isAdmin(roles: RoleName[]): boolean {
  return roles.includes('admin') || roles.includes('superadmin');
}

export function normalizePartList(
  parts: Array<{ partNumber: number; etag: string }>,
): Array<{ partNumber: number; etag: string }> {
  const byNumber = new Map<number, string>();
  for (const part of parts) byNumber.set(part.partNumber, part.etag.replace(/^"|"$/g, ''));
  return [...byNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([partNumber, etag]) => ({ partNumber, etag }));
}

export function parseCursorPagination<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}

export interface KeysetPosition {
  createdAt: Date;
  id: string;
}

/**
 * Курсор для сортировки по дате: одного id недостаточно, потому что порядок
 * задаёт created_at, и сравнение по id пропускало бы или дублировало строки.
 */
export function encodeKeysetCursor(position: KeysetPosition): string {
  return Buffer.from(`${position.createdAt.toISOString()}|${position.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeKeysetCursor(cursor: string): KeysetPosition | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) return null;
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

export function parseKeysetPagination<T extends KeysetPosition>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeKeysetCursor(last) : null,
  };
}
