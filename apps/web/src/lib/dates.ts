export const NOVOSIBIRSK_TIME_ZONE = 'Asia/Novosibirsk';
export const NOVOSIBIRSK_UTC_OFFSET = '+07:00';
export const NOVOSIBIRSK_LABEL = 'Новосибирск (UTC+7)';

const inputFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NOVOSIBIRSK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function dateValue(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toNovosibirskInput(value: string | Date): string {
  const parts = Object.fromEntries(
    inputFormatter
      .formatToParts(dateValue(value))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function fromNovosibirskInput(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new Error('Укажите дату и время полностью');
  }
  const date = new Date(`${value}:00${NOVOSIBIRSK_UTC_OFFSET}`);
  if (Number.isNaN(date.getTime())) throw new Error('Указана некорректная дата');
  return date.toISOString();
}

export function novosibirskInputAfter(hours: number): string {
  const fiveMinutes = 5 * 60 * 1_000;
  const timestamp = Math.ceil((Date.now() + hours * 60 * 60 * 1_000) / fiveMinutes) * fiveMinutes;
  return toNovosibirskInput(new Date(timestamp));
}

export function addHoursToNovosibirskInput(value: string, hours: number): string {
  const timestamp = new Date(fromNovosibirskInput(value)).getTime() + hours * 60 * 60 * 1_000;
  return toNovosibirskInput(new Date(timestamp));
}

export function formatNovosibirskDate(value: string | Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: NOVOSIBIRSK_TIME_ZONE,
  }).format(dateValue(value));
}

export function formatNovosibirskDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: NOVOSIBIRSK_TIME_ZONE,
  }).format(dateValue(value));
}
