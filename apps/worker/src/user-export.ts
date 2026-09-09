import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { leaderIdBindings, users } from '@cpi/db';
import type { WorkerContext } from './context';
import type { SpreadsheetSheet } from './xlsx';

interface Identity {
  provider: 'telegram' | 'max';
  externalUserId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  chatId: string | null;
  canMessage: boolean;
  firstBotStartedAt: string | null;
  firstAppOpenedAt: string | null;
}

export interface ConversionUser {
  id: string;
  fullName: string | null;
  messengerName: string;
  telegramId: string | null;
  telegramUsername: string | null;
  maxId: string | null;
  botUsed: boolean;
  botEvidence: string;
  appOpened: boolean;
  appEvidence: string;
  firstBotStartedAt: string | null;
  firstAppOpenedAt: string | null;
  leaderId: number | null;
  leaderLinkedAt: Date | null;
  inChat: boolean | null;
  chatCheckedAt: Date | null;
  chatError: string | null;
  status: string;
  canMessageTelegram: boolean | null;
  canMessageMax: boolean | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export function chatMembership(member: { status: string; is_member?: boolean }): boolean | null {
  if (['creator', 'administrator', 'member'].includes(member.status)) return true;
  if (member.status === 'restricted') return member.is_member ?? null;
  if (['left', 'kicked'].includes(member.status)) return false;
  return null;
}

const yesNo = (value: boolean | null) => (value === null ? 'Неизвестно' : value ? 'Да' : 'Нет');
const earliest = (dates: Array<string | null>) =>
  dates.filter((date): date is string => Boolean(date)).sort()[0] ?? null;

async function loadUsers(context: WorkerContext, snapshotAt: Date): Promise<ConversionUser[]> {
  const output: ConversionUser[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await context.db
      .select({
        id: users.id,
        fullName: users.fullName,
        telegramId: users.telegramUserId,
        username: users.telegramUsername,
        consentAt: users.consentAt,
        status: users.status,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        leaderId: leaderIdBindings.leaderIdUserId,
        leaderLinkedAt: leaderIdBindings.linkedAt,
        hasParticipantRole: sql<boolean>`exists(select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${users.id} and r.name = 'participant')`,
        identities: sql<Identity[]>`coalesce((select jsonb_agg(jsonb_build_object(
        'provider', i.provider, 'externalUserId', i.external_user_id, 'username', i.username,
        'firstName', i.first_name, 'lastName', i.last_name, 'chatId', i.chat_id, 'canMessage', i.can_message,
        'firstBotStartedAt', i.first_bot_started_at, 'firstAppOpenedAt', i.first_app_opened_at
      ) order by i.provider) from user_messenger_identities i where i.user_id = ${users.id}), '[]'::jsonb)`,
      })
      .from(users)
      .leftJoin(leaderIdBindings, eq(leaderIdBindings.userId, users.id))
      .where(and(lte(users.createdAt, snapshotAt), cursor ? gt(users.id, cursor) : undefined))
      .orderBy(asc(users.id))
      .limit(500);
    for (const row of rows) {
      const telegram = row.identities.find((identity) => identity.provider === 'telegram');
      const max = row.identities.find((identity) => identity.provider === 'max');
      const firstBotStartedAt = earliest(
        row.identities.map((identity) => identity.firstBotStartedAt),
      );
      const firstAppOpenedAt = earliest(
        row.identities.map((identity) => identity.firstAppOpenedAt),
      );
      const legacyBotContact = row.identities.some((identity) => identity.chatId !== null);
      output.push({
        id: row.id,
        fullName: row.fullName,
        messengerName: row.identities
          .map((identity) => [identity.firstName, identity.lastName].filter(Boolean).join(' '))
          .filter(Boolean)
          .join(' / '),
        telegramId: telegram?.externalUserId ?? row.telegramId?.toString() ?? null,
        telegramUsername: telegram?.username ?? row.username,
        maxId: max?.externalUserId ?? null,
        botUsed: Boolean(firstBotStartedAt || legacyBotContact),
        botEvidence: firstBotStartedAt
          ? 'Зафиксирован запуск бота'
          : legacyBotContact
            ? 'История контакта с ботом; дата запуска неизвестна'
            : 'Нет истории запуска',
        appOpened: Boolean(firstAppOpenedAt || row.consentAt || row.hasParticipantRole),
        appEvidence: firstAppOpenedAt
          ? 'Зафиксирован вход в приложение'
          : row.consentAt
            ? 'Заполненный профиль в приложении'
            : row.hasParticipantRole
              ? 'Роль участника после входа (исторический признак)'
              : 'Нет истории входа',
        firstBotStartedAt,
        firstAppOpenedAt,
        leaderId: row.leaderId,
        leaderLinkedAt: row.leaderLinkedAt,
        inChat: null,
        chatCheckedAt: null,
        chatError: null,
        status: row.status,
        canMessageTelegram: telegram?.canMessage ?? null,
        canMessageMax: max?.canMessage ?? null,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
      });
    }
    if (rows.length < 500) return output;
    cursor = rows.at(-1)!.id;
  }
}

export async function telegramRead<T>(
  token: string,
  method: string,
  body: object,
  fetcher = fetch,
): Promise<T> {
  // Never propagate fetch errors containing the token-bearing URL into logs or export cells.
  let response: Response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Telegram: соединение недоступно или истекло время ожидания');
  }
  let payload: { ok?: boolean; result?: T; error_code?: number };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new Error('Telegram: некорректный ответ');
  }
  if (!response.ok || payload.ok !== true || payload.result === undefined) {
    throw new Error(`Telegram: ошибка ${payload.error_code ?? response.status}`);
  }
  return payload.result;
}

export function conversionSheets(
  rows: ConversionUser[],
  chatTotal: number | null,
  snapshotAt: Date,
  chatNote: string,
): SpreadsheetSheet[] {
  const bot = rows.filter((row) => row.botUsed);
  const telegramBot = bot.filter((row) => row.telegramId);
  const inChat = rows.filter((row) => row.inChat === true);
  const botChat = telegramBot.filter((row) => row.inChat === true);
  const summary: Array<{
    metric: string;
    count: number | null;
    denominator: number | null;
    percent: number | null;
    note: string;
  }> = [];
  const add = (metric: string, count: number | null, denominator: number | null, note: string) =>
    summary.push({
      metric,
      count,
      denominator,
      percent:
        count !== null && denominator !== null && denominator > 0
          ? Math.round((count / denominator) * 10_000) / 100
          : null,
      note,
    });
  add(
    'Все пользователи в базе',
    rows.length,
    null,
    'Одна строка на внутренний ID; связанные Telegram и MAX объединены',
  );
  add(
    'Пользовались ботом',
    bot.length,
    rows.length,
    'Зафиксированный запуск или исторический контакт; см. источник в реестре',
  );
  add(
    'Открывали приложение',
    rows.filter((row) => row.appOpened).length,
    rows.length,
    'Включая исторические признаки входа',
  );
  add(
    'Бот → приложение',
    bot.filter((row) => row.appOpened).length,
    bot.length,
    'Пересечение признаков; не доказывает порядок действий',
  );
  add(
    'Telegram-пользователи бота',
    telegramBot.length,
    bot.length,
    'База для конверсии бота в Telegram-чат',
  );
  add(
    'Всего аккаунтов в чате Каталиста',
    chatTotal,
    null,
    'Счётчик Telegram включает ботов; это не число людей',
  );
  add(
    'Известные пользователи в чате',
    inChat.length,
    chatTotal,
    'Среди пользователей базы, членство проверено при выгрузке',
  );
  add(
    'Telegram-бот → чат Каталиста',
    botChat.length,
    telegramBot.length,
    'Неизвестное членство остаётся в знаменателе; доля является нижней границей',
  );
  add(
    'Чат → известные пользователи бота',
    botChat.length,
    chatTotal,
    'Нижняя граница: полный реестр участников чата Bot API не выдаёт; знаменатель включает ботов',
  );
  add(
    'Подтверждённая привязка Leader ID',
    rows.filter((row) => row.leaderId !== null).length,
    rows.length,
    'Только текущая OAuth-привязка',
  );
  add(
    'Бот → Leader ID',
    bot.filter((row) => row.leaderId !== null).length,
    bot.length,
    'Текущая привязка среди пользователей бота',
  );
  add(
    'Бот + чат → Leader ID',
    botChat.filter((row) => row.leaderId !== null).length,
    botChat.length,
    'База: подтверждённые участники чата, пользовавшиеся ботом',
  );
  add(
    'Не удалось проверить членство',
    rows.filter((row) => row.telegramId && row.inChat === null).length,
    rows.filter((row) => row.telegramId).length,
    chatNote,
  );
  add(
    'Нет истории запуска бота',
    rows.filter((row) => !row.botUsed).length,
    rows.length,
    'Отсутствие записи не означает, что человек никогда не запускал бота',
  );
  add(
    'Нет истории входа в приложение',
    rows.filter((row) => !row.appOpened).length,
    rows.length,
    'Отсутствие записи не означает, что человек никогда не открывал приложение',
  );
  const details = rows.map((row) => ({
    ...row,
    botUsed: row.botUsed ? 'Да' : 'Нет данных',
    appOpened: row.appOpened ? 'Да' : 'Нет данных',
    leaderLinked: row.leaderId !== null ? 'Да' : 'Нет',
    inChat: row.telegramId ? yesNo(row.inChat) : 'Нет Telegram',
    canMessageTelegram: yesNo(row.canMessageTelegram),
    canMessageMax: yesNo(row.canMessageMax),
  }));
  return [
    {
      name: 'Пользователи',
      columns: [
        { header: 'ФИО', key: 'fullName', width: 36 },
        { header: 'Имя в мессенджере', key: 'messengerName', width: 30 },
        { header: 'ID пользователя', key: 'id', width: 38 },
        { header: 'Telegram ID', key: 'telegramId', width: 22 },
        { header: 'Telegram username', key: 'telegramUsername', width: 25 },
        { header: 'MAX ID', key: 'maxId', width: 22 },
        { header: 'Пользовался ботом', key: 'botUsed', width: 22 },
        { header: 'Источник: бот', key: 'botEvidence', width: 56 },
        { header: 'Открывал приложение', key: 'appOpened', width: 24 },
        { header: 'Источник: приложение', key: 'appEvidence', width: 56 },
        { header: 'В чате Каталиста', key: 'inChat', width: 22 },
        { header: 'Чат проверен, UTC', key: 'chatCheckedAt', width: 28 },
        { header: 'Ошибка проверки чата', key: 'chatError', width: 48 },
        { header: 'Привязан Leader ID', key: 'leaderLinked', width: 24 },
        { header: 'Leader ID', key: 'leaderId', width: 22 },
        { header: 'Дата привязки, UTC', key: 'leaderLinkedAt', width: 28 },
        { header: 'Первый записанный запуск бота, UTC', key: 'firstBotStartedAt', width: 32 },
        { header: 'Первый записанный вход, UTC', key: 'firstAppOpenedAt', width: 32 },
        { header: 'Можно писать в Telegram', key: 'canMessageTelegram', width: 28 },
        { header: 'Можно писать в MAX', key: 'canMessageMax', width: 24 },
        { header: 'Статус пользователя', key: 'status', width: 22 },
        { header: 'Создан, UTC', key: 'createdAt', width: 28 },
        { header: 'Последняя активность, UTC', key: 'lastSeenAt', width: 28 },
      ],
      rows: details,
    },
    {
      name: 'Конверсия',
      columns: [
        { header: 'Показатель', key: 'metric', width: 48 },
        { header: 'Количество', key: 'count', width: 16 },
        { header: 'База расчёта', key: 'denominator', width: 18 },
        { header: 'Доля, %', key: 'percent', width: 14 },
        { header: 'Пояснение', key: 'note', width: 100 },
      ],
      rows: summary,
    },
    {
      name: 'Методика',
      columns: [
        { header: 'Параметр', key: 'key', width: 30 },
        { header: 'Описание', key: 'value', width: 110 },
      ],
      rows: [
        { key: 'Начало выгрузки, UTC', value: snapshotAt.toISOString() },
        { key: 'Проверка чата', value: chatNote },
        {
          key: 'История',
          value:
            'Раздельный учёт запусков и входов добавлен 2026-09-09. Ранние записи восстановлены только по доступным признакам, даты не выдумываются.',
        },
        {
          key: 'База расчёта',
          value:
            'Все пользователи в базе, включая заблокированных и администраторов. Статус указан в реестре. Реестр не ограничен 100 строками интерфейса.',
        },
        {
          key: 'Чат Каталиста',
          value:
            'getChatMember для известных Telegram ID; getChatMemberCount для общего количества аккаунтов. Проверки выполняются последовательно во время выгрузки; время указано в каждой строке. Ошибки не считаются отсутствием в чате.',
        },
        {
          key: 'Leader ID',
          value:
            'Наличие текущей подтверждённой OAuth-привязки. Отправленное вручную число или контакт в CRM не считаются привязкой.',
        },
        {
          key: 'Конверсия',
          value:
            'Доли пересечений текущих признаков; не хронологическая воронка. Нулевая или неизвестная база даёт пустую долю. Связанные аккаунты объединены по ID пользователя; несвязанные аккаунты одного человека сопоставить невозможно.',
        },
      ],
    },
  ];
}

export async function buildUserSheets(
  context: WorkerContext,
  onProgress: (value: number) => Promise<void>,
): Promise<SpreadsheetSheet[]> {
  const snapshotAt = new Date();
  const rows = await loadUsers(context, snapshotAt);
  let chatId = context.config.TELEGRAM_CATALYST_CHAT_ID;
  if (!chatId && context.redis) {
    try {
      const stored = await context.redis.get(`${context.config.REDIS_PREFIX}:bot:catalyst-chat:v1`);
      const value = stored ? (JSON.parse(stored) as { chatId?: unknown }) : null;
      if (typeof value?.chatId === 'string' && /^-\d+$/.test(value.chatId)) chatId = value.chatId;
    } catch {
      /* Missing chat configuration is reported in the workbook. */
    }
  }
  let chatTotal: number | null = null;
  let chatNote = 'Чат Каталиста или Telegram-бот не настроен';
  const token = context.config.TELEGRAM_BOT_TOKEN;
  let canCheck = false;
  if (chatId && token) {
    try {
      const me = await telegramRead<{ id: number }>(token, 'getMe', {});
      const member = await telegramRead<{ status: string }>(token, 'getChatMember', {
        chat_id: chatId,
        user_id: me.id,
      });
      chatTotal = await telegramRead<number>(token, 'getChatMemberCount', { chat_id: chatId });
      canCheck = ['administrator', 'creator'].includes(member.status);
      chatNote = canCheck
        ? 'Текущее членство проверено через Telegram Bot API'
        : 'Боту нужны права администратора чата для достоверной проверки';
    } catch (caught) {
      chatNote = caught instanceof Error ? caught.message : 'Не удалось проверить чат';
    }
  }
  const telegramRows = rows.filter((row) => row.telegramId);
  let consecutiveErrors = 0;
  for (const [index, row] of telegramRows.entries()) {
    if (canCheck) {
      await delay(100);
      try {
        const member = await telegramRead<{ status: string; is_member?: boolean }>(
          token!,
          'getChatMember',
          { chat_id: chatId, user_id: row.telegramId },
        );
        row.inChat = chatMembership(member);
        row.chatCheckedAt = new Date();
        row.chatError = row.inChat === null ? 'Telegram вернул неизвестный статус' : null;
        consecutiveErrors = 0;
      } catch (caught) {
        row.chatError = caught instanceof Error ? caught.message : 'Ошибка проверки';
        if (++consecutiveErrors >= 5) {
          canCheck = false;
          chatNote =
            'Проверка прервана после 5 последовательных ошибок Telegram; непроверенные строки помечены';
        }
      }
    } else {
      row.chatError = chatNote;
    }
    if (index % 10 === 0)
      await onProgress(10 + Math.floor(((index + 1) / Math.max(telegramRows.length, 1)) * 65));
  }
  return conversionSheets(rows, chatTotal, snapshotAt, chatNote);
}
