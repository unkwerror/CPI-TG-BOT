/**
 * Правила ФИО повторяют CRM (`parseRussianFullName` в @cpi-crm/domain): CRM
 * заводит участника только по фамилии, имени и отчеству русскими буквами, а
 * активные карточки дополнительно проверяются ограничением
 * persons_active_russian_fio_check. Если бот примет что-то другое, отправка
 * доедет до CRM и повиснет в очереди ручного разбора.
 */
const RUSSIAN_NAME_COMPONENT = /^[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*$/u;

export const FULL_NAME_HINT = 'Укажите фамилию, имя и отчество русскими буквами';

export function normalizeFullNameInput(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** Разбирает строку в три части ФИО или возвращает null, как это делает CRM. */
export function parseRussianFullName(
  value: unknown,
): { lastName: string; firstName: string; patronymic: string; fullName: string } | null {
  if (typeof value !== 'string') return null;
  const parts = normalizeFullNameInput(value).split(' ');
  if (parts.length !== 3) return null;
  if (parts.some((part) => !RUSSIAN_NAME_COMPONENT.test(part))) return null;
  const [lastName, firstName, patronymic] = parts as [string, string, string];
  return { lastName, firstName, patronymic, fullName: `${lastName} ${firstName} ${patronymic}` };
}

export function isRussianNameComponent(value: string): boolean {
  return RUSSIAN_NAME_COMPONENT.test(normalizeFullNameInput(value));
}

/**
 * Профиль считается заполненным, только когда ФИО пригодно для CRM. Проверка по
 * «есть непустое имя» оставляла бы участников, зарегистрированных до этого
 * правила, навсегда в старом формате — и их отправки в CRM не попадали бы.
 */
export function isCrmReadyFullName(value: string | null | undefined): boolean {
  return parseRussianFullName(value) !== null;
}
