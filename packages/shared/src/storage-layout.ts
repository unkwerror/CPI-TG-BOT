/**
 * Раскладка объектов в общем хранилище артефактов.
 *
 * Бакет один на этот бот и на CRM, поэтому владельца определяет верхняя папка:
 * `locker/` и `crm/` не пересекаются, и по SFTP это выглядит как два независимых
 * дерева.
 *
 * Внутри `locker/` файл проходит две стоянки. `incoming` — байты, которые ещё не
 * прошли проверку: имя папки собрано из идентификаторов, потому что на момент
 * подписи ссылки других надёжных данных нет. `artifacts` — итоговое место с
 * человеческими именами папок, куда файл переезжает после успешной проверки.
 *
 * Имя папки фиксируется в момент переезда и потом не переписывается:
 * переименование мероприятия не должно менять ключи уже сохранённых файлов.
 */

const MAX_SEGMENT_LENGTH = 80;

/** Символы, из-за которых папку не открыть в проводнике или по SFTP. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f/\\:*?"<>|]/gu;

export function sanitizePathSegment(value: string, fallback = 'без названия'): string {
  const cleaned = value
    .normalize('NFC')
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[.\s]+/u, '')
    .replace(/[.\s]+$/u, '');
  if (!cleaned) return fallback;
  return cleaned.length > MAX_SEGMENT_LENGTH
    ? cleaned.slice(0, MAX_SEGMENT_LENGTH).trim()
    : cleaned;
}

/** Имя файла режется по основе, чтобы расширение осталось на месте. */
export function sanitizeFileName(value: string, fallback = 'файл'): string {
  const cleaned = value
    .normalize('NFC')
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return fallback;
  const dot = cleaned.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < cleaned.length - 1 && cleaned.length - dot <= 12;
  const base = hasExtension ? cleaned.slice(0, dot) : cleaned;
  const extension = hasExtension ? cleaned.slice(dot).toLowerCase() : '';
  const safeBase = sanitizePathSegment(base, fallback).slice(0, MAX_SEGMENT_LENGTH);
  return `${safeBase || fallback}${extension}`;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/gu, '');
  return trimmed ? `${trimmed}/` : '';
}

/** Раздел внутри дерева владельца: по нему же чистится хранилище мероприятия. */
export function sectionPrefix(prefix: string, section: string): string {
  return `${normalizePrefix(prefix)}${section}/`;
}

/** Байты, которые ещё не прошли проверку. */
export function incomingObjectKey(
  prefix: string,
  input: {
    readonly eventId: string;
    readonly submissionId: string;
    readonly artifactId: string;
  },
): string {
  return `${sectionPrefix(prefix, 'incoming')}${input.eventId}/${input.submissionId}/${input.artifactId}`;
}

/**
 * Итоговое место файла: мероприятие, участник, имя файла.
 *
 * Полные тёзки попадают в одну папку — точная принадлежность файла остаётся в
 * базе и в метаданных объекта, папка нужна человеку для чтения.
 */
export function artifactObjectKey(
  prefix: string,
  input: {
    readonly eventTitle: string;
    readonly personName: string | null;
    readonly telegramUserId: string | bigint;
    readonly fileName: string;
  },
): string {
  const event = sanitizePathSegment(input.eventTitle, 'Без мероприятия');
  const person = sanitizePathSegment(
    input.personName ?? '',
    `Без имени ${String(input.telegramUserId)}`,
  );
  return `${sectionPrefix(prefix, 'artifacts')}${event}/${person}/${sanitizeFileName(input.fileName)}`;
}

/** Выгрузка живёт час и лежит отдельно от файлов участников. */
export function exportObjectKey(
  prefix: string,
  input: {
    readonly eventId: string;
    readonly exportJobId: string;
    readonly kind: string;
  },
): string {
  return `${sectionPrefix(prefix, 'exports')}${input.eventId}/${input.exportJobId}.${input.kind}`;
}

/** Папки мероприятия, которые можно вычистить по префиксу при его удалении. */
export function eventStoragePrefixes(prefix: string, eventId: string): string[] {
  return [
    `${sectionPrefix(prefix, 'incoming')}${eventId}/`,
    `${sectionPrefix(prefix, 'exports')}${eventId}/`,
  ];
}

/** Занятое имя разводится суффиксом, как это делает проводник. */
export function withCopySuffix(objectKey: string, attempt: number): string {
  if (attempt <= 1) return objectKey;
  const slash = objectKey.lastIndexOf('/');
  const directory = objectKey.slice(0, slash + 1);
  const name = objectKey.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1 && name.length - dot <= 12;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : '';
  return `${directory}${base} (${String(attempt)})${extension}`;
}

/**
 * Подписанная ссылка для браузера.
 *
 * Хранилище провайдера отвечает не со всех своих адресов: из сетей пользователей
 * часть из них молча отваливается по таймауту, и загрузка падает сетевой
 * ошибкой. Поэтому браузеру отдаётся адрес на нашем домене, а до облака запрос
 * доводит reverse proxy. Подпись при этом не трогаем: она посчитана для хоста
 * хранилища, и прокси подставляет этот же хост.
 */
export function publicStorageUrl(signedUrl: string, publicBase: string): string {
  if (!publicBase) return signedUrl;
  const signed = new URL(signedUrl);
  const base = new URL(publicBase);
  const prefix = base.pathname.replace(/\/+$/u, '');
  return `${base.origin}${prefix}${signed.pathname}${signed.search}`;
}
