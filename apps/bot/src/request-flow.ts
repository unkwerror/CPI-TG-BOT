import { eventRequestTextSchema } from '@cpi/shared';

/** Что бот ждёт от человека прямо сейчас. */
export type RequestStep = 'text' | 'fullName' | 'phone';

export interface RequestDraft {
  eventId: string;
  step: RequestStep;
  text?: string;
  attachments?: Array<{ fileId: string; kind: string; fileName?: string }>;
}

export interface RequestProfile {
  fullName: string | null;
  phone: string | null;
}

const CALLBACK_EVENT_PREFIX = 'req:ev:';
export const REQUEST_MENU_CALLBACK = 'req:menu';

export function eventChoiceCallback(eventId: string): string {
  return `${CALLBACK_EVENT_PREFIX}${eventId}`;
}

export function parseEventChoiceCallback(data: string | undefined | null): string | null {
  if (!data?.startsWith(CALLBACK_EVENT_PREFIX)) return null;
  const eventId = data.slice(CALLBACK_EVENT_PREFIX.length).trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(eventId)
    ? eventId
    : null;
}

/**
 * Карточку участника CRM создаёт только по полному ФИО, а телефон — единственный
 * способ связаться с человеком вне Telegram, поэтому не хватающее спрашивается
 * сразу после текста запроса. Уже заполненный профиль ничего не спрашивает.
 */
export function nextStep(profile: RequestProfile): RequestStep | null {
  if (!profile.fullName?.trim()) return 'fullName';
  if (!profile.phone?.trim()) return 'phone';
  return null;
}

export function parseRequestText(value: string): { text: string } | { error: string } {
  const parsed = eventRequestTextSchema.safeParse(value);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Опишите запрос чуть подробнее' };
  }
  return { text: parsed.data };
}

const NAME_PART = /^[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*$/u;

/**
 * CRM принимает карточку только с фамилией, именем и отчеством русскими буквами,
 * поэтому такая же проверка стоит и здесь: иначе человек считает, что всё указал,
 * а его запись CRM молча отклоняет и рассылка до него не доходит.
 */
export function parseFullName(value: string): { fullName: string } | { error: string } {
  const parts = value.trim().replace(/\s+/gu, ' ').split(' ');
  if (parts.length !== 3 || parts.some((part) => !NAME_PART.test(part))) {
    return {
      error:
        'Нужны фамилия, имя и отчество русскими буквами — три слова, например «Иванов Иван Иванович».',
    };
  }
  return { fullName: parts.join(' ') };
}

export function parsePhone(value: string): { phone: string } | { error: string } {
  const digits = value.replace(/\D/gu, '');
  if (digits.length < 10 || digits.length > 15) {
    return { error: 'Не похоже на номер. Напишите его цифрами, например +7 913 000-00-00.' };
  }
  return { phone: `+${digits}` };
}

export const REQUEST_MESSAGES = {
  chooseEvent: 'Выберите событие — и опишите, с чем нужна помощь.',
  noEvents: 'Сейчас нет событий, по которым мы принимаем запросы.',
  eventGone: 'По этому событию запросы больше не принимаются. Выберите другое.',
  askFullName:
    'Как к вам обращаться? Напишите фамилию, имя и отчество — организаторам важно понимать, с кем они говорят.',
  askPhone: 'Оставьте телефон для связи: нажмите кнопку ниже или напишите номер.',
  saved: 'Запрос принят. Организаторы посмотрят его и ответят вам здесь, в Telegram.',
  appended: 'Добавили это к вашему запросу — организаторы увидят и новое сообщение.',
  expired: 'Запрос не сохранился: слишком долгая пауза. Начните заново — выберите событие.',
  idle: 'Чтобы оставить запрос, выберите событие. Материалы мероприятий — в приложении.',
} as const;

/** Telegram отклоняет сообщение длиннее 4096 символов, а описание допускает 10 000. */
const MESSAGE_LIMIT = 4_000;

function fitMessage(text: string): string {
  if (text.length <= MESSAGE_LIMIT) return text;
  const cut = text.slice(0, MESSAGE_LIMIT);
  const boundary = cut.lastIndexOf(' ');
  const trimmed = boundary > MESSAGE_LIMIT - 200 ? cut.slice(0, boundary) : cut;
  return `${trimmed.trimEnd()}…`;
}

/**
 * Приглашение написать запрос — это описание события из админки: там же его видит
 * человек в приложении, поэтому формулировка правится в одном месте и не расходится.
 * Шаблон остаётся запасным вариантом для событий без описания.
 */
export function askTextMessage(input: {
  title: string;
  organizer: string;
  description?: string | null;
}): string {
  const description = input.description?.trim();
  if (description) return fitMessage(description);
  return [
    `Хотите подать заявку в «${input.title}» и нужна помощь с заполнением?`,
    '',
    `Напишите свой вопрос или опишите, с чем возникли сложности. ${input.organizer} посмотрит запрос и поможет разобраться.`,
  ].join('\n');
}
