import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Bot, InlineKeyboard, Keyboard, webhookCallback, type Context } from 'grammy';
import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import pino from 'pino';
import { botEnvironmentSchema, parseEnvironment } from '@cpi/config';
import {
  artifacts,
  createDatabase,
  events,
  notificationDeliveries,
  submissions,
  users,
} from '@cpi/db';
import {
  ensureBotUser,
  isUnreachableRecipientError,
  markBotBlocked,
  recordCampaignReply,
} from './audience';
import {
  CAMPAIGN_REPLY_MESSAGES,
  parseCampaignCallbackData,
  parseCampaignStartPayload,
  parseEventStartPayload,
} from './campaign-payload';
import {
  askTextMessage,
  eventChoiceCallback,
  nextStep,
  parseEventChoiceCallback,
  parseFullName,
  parsePhone,
  parseRequestText,
  REQUEST_MENU_CALLBACK,
  REQUEST_MESSAGES,
  type RequestDraft,
} from './request-flow';
import {
  claimNoticeDelivery,
  formatRequestNotice,
  loadNoticeRecipients,
  loadRequestNotice,
  markNoticeDelivered,
  markNoticeFailed,
  noticeDeduplicationKey,
} from './request-notice';
import {
  clearDraft,
  findRequestEvent,
  listRequestEvents,
  readDraft,
  readProfile,
  saveDraft,
  saveEventRequest,
  saveProfileFields,
} from './requests';

const config = parseEnvironment(botEnvironmentSchema, process.env);
const logger = pino({ level: config.LOG_LEVEL });
const { db, pool } = createDatabase(config.DATABASE_URL, { max: 3 });
const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
const token = config.TELEGRAM_BOT_TOKEN?.trim();
const configured = Boolean(
  token &&
  !token.startsWith('CHANGE_ME') &&
  !token.includes('required') &&
  /^\d+:[A-Za-z0-9_-]+$/.test(token),
);
const bot = configured ? new Bot(token!) : null;
let notificationWorker: Worker | null = null;

function webAppUrl(parameters?: { event?: string; tab?: string }): string {
  const url = new URL(config.WEB_APP_URL);
  if (parameters?.event) url.searchParams.set('event', parameters.event);
  if (parameters?.tab) url.searchParams.set('tab', parameters.tab);
  return url.toString();
}

function mainKeyboard(eventCode?: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Выбрать событие', REQUEST_MENU_CALLBACK)
    .row()
    .webApp(
      eventCode ? 'Открыть мероприятие' : 'Открыть приложение',
      webAppUrl(eventCode ? { event: eventCode } : undefined),
    );
}

type RequestAttachment = { fileId: string; kind: string; fileName?: string };

/** Длинное название не читается на кнопке — Telegram обрезает его без предупреждения. */
function buttonLabel(title: string): string {
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}

async function showEventChoice(context: Context): Promise<void> {
  const available = await listRequestEvents(db);
  if (available.length === 0) {
    await context.reply(REQUEST_MESSAGES.noEvents, {
      reply_markup: new InlineKeyboard().webApp('Открыть приложение', webAppUrl()),
    });
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const event of available) {
    keyboard.text(buttonLabel(event.title), eventChoiceCallback(event.id)).row();
  }
  await context.reply(REQUEST_MESSAGES.chooseEvent, { reply_markup: keyboard });
}

async function startRequest(context: Context, eventId: string): Promise<void> {
  const sender = context.from;
  if (!sender) return;
  const event = await findRequestEvent(db, eventId);
  if (!event) {
    await context.reply(REQUEST_MESSAGES.eventGone, { reply_markup: mainKeyboard() });
    return;
  }
  await saveDraft(connection, config.REDIS_PREFIX, sender.id, {
    eventId: event.id,
    step: 'text',
  });
  await context.reply(askTextMessage(event));
}

/**
 * Ведёт диалог запроса по шагам. Возвращает признак «сообщение относилось к
 * запросу»: без него обычная переписка попадала бы в чужой сценарий, а шаг
 * запроса — в ответ «не понял».
 */
async function advanceRequest(
  context: Context,
  value: string,
  attachments: RequestAttachment[] = [],
): Promise<boolean> {
  const sender = context.from;
  if (!sender || sender.is_bot) return false;
  const draft = await readDraft(connection, config.REDIS_PREFIX, sender.id);
  if (!draft) return false;

  const event = await findRequestEvent(db, draft.eventId);
  if (!event) {
    await clearDraft(connection, config.REDIS_PREFIX, sender.id);
    await context.reply(REQUEST_MESSAGES.eventGone, { reply_markup: mainKeyboard() });
    return true;
  }
  const profile = await readProfile(db, sender.id);
  if (!profile) {
    await clearDraft(connection, config.REDIS_PREFIX, sender.id);
    await context.reply(REQUEST_MESSAGES.expired, { reply_markup: mainKeyboard() });
    return true;
  }

  if (draft.step === 'fullName') {
    const parsed = parseFullName(value);
    if ('error' in parsed) {
      await context.reply(parsed.error);
      return true;
    }
    await saveProfileFields(db, profile.id, { fullName: parsed.fullName });
    return finishOrAsk(context, sender.id, draft, { ...profile, fullName: parsed.fullName });
  }

  if (draft.step === 'phone') {
    const parsed = parsePhone(value);
    if ('error' in parsed) {
      await context.reply(parsed.error);
      return true;
    }
    await saveProfileFields(db, profile.id, { phone: parsed.phone });
    return finishOrAsk(context, sender.id, draft, { ...profile, phone: parsed.phone });
  }

  const parsed = parseRequestText(value);
  if ('error' in parsed) {
    await context.reply(parsed.error);
    return true;
  }
  return finishOrAsk(
    context,
    sender.id,
    {
      ...draft,
      text: parsed.text,
      attachments: [...(draft.attachments ?? []), ...attachments],
    },
    profile,
  );
}

async function finishOrAsk(
  context: Context,
  telegramUserId: number,
  draft: RequestDraft,
  profile: { id: string; fullName: string | null; phone: string | null },
): Promise<boolean> {
  if (!draft.text) {
    await saveDraft(connection, config.REDIS_PREFIX, telegramUserId, { ...draft, step: 'text' });
    await context.reply(REQUEST_MESSAGES.chooseEvent);
    return true;
  }
  const step = nextStep(profile);
  if (step === 'fullName') {
    await saveDraft(connection, config.REDIS_PREFIX, telegramUserId, {
      ...draft,
      step: 'fullName',
    });
    await context.reply(REQUEST_MESSAGES.askFullName);
    return true;
  }
  if (step === 'phone') {
    await saveDraft(connection, config.REDIS_PREFIX, telegramUserId, { ...draft, step: 'phone' });
    await context.reply(REQUEST_MESSAGES.askPhone, {
      reply_markup: new Keyboard().requestContact('Поделиться телефоном').resized().oneTime(),
    });
    return true;
  }
  const saved = await saveEventRequest(db, {
    eventId: draft.eventId,
    userId: profile.id,
    text: draft.text,
    attachments: draft.attachments ?? [],
  });
  await clearDraft(connection, config.REDIS_PREFIX, telegramUserId);
  await context.reply(saved.appended ? REQUEST_MESSAGES.appended : REQUEST_MESSAGES.saved, {
    reply_markup: { remove_keyboard: true },
  });
  return true;
}

if (bot) {
  // Регистрация участника идёт до обработчиков и не должна ломать ответ: даже
  // если запись не удалась, человек всё равно получит сообщение.
  bot.use(async (context, next) => {
    const sender = context.from;
    if (sender && !sender.is_bot) {
      try {
        await ensureBotUser(db, sender);
      } catch (error) {
        logger.error({ error, telegramUserId: sender.id }, 'Failed to record bot user');
      }
    }
    await next();
  });

  bot.command('start', async (context) => {
    const payload = context.match?.trim();
    const campaignReply = parseCampaignStartPayload(payload);
    if (campaignReply) {
      await recordCampaignReply(db, campaignReply);
      await context.reply(CAMPAIGN_REPLY_MESSAGES[campaignReply.action], {
        reply_markup: mainKeyboard(),
      });
      return;
    }
    const eventCode = parseEventStartPayload(payload);
    await context.reply(
      eventCode
        ? 'Мероприятие найдено. Откройте приложение, чтобы отправить материалы.'
        : 'Здравствуйте! Здесь можно оставить запрос организаторам или передать материалы мероприятия.',
      { reply_markup: mainKeyboard(eventCode ?? undefined) },
    );
  });
  bot.command('request', async (context) => {
    await showEventChoice(context);
  });
  bot.command('materials', async (context) => {
    await context.reply('Ваши материалы доступны в приложении.', {
      reply_markup: new InlineKeyboard().webApp('Мои материалы', webAppUrl({ tab: 'mine' })),
    });
  });
  bot.command('help', async (context) => {
    await context.reply(
      'Чтобы получить помощь организаторов, нажмите «Выбрать событие» и опишите свой запрос. Материалы мероприятий — в приложении.',
      { reply_markup: mainKeyboard() },
    );
  });
  bot.on('message:contact', async (context) => {
    const sender = context.from;
    const contact = context.message.contact;
    if (!sender || contact.user_id !== sender.id) {
      await context.reply('Можно сохранить только ваш собственный номер Telegram.');
      return;
    }
    const digits = contact.phone_number.replace(/\D/g, '').slice(0, 32);
    if (!digits) {
      await context.reply('Telegram не передал номер. Введите его вручную в профиле.');
      return;
    }
    // Номером могут делиться и посреди запроса: тогда он завершает диалог, а не
    // просто оседает в профиле.
    if (await advanceRequest(context, `+${digits}`)) return;
    const [updated] = await db
      .update(users)
      .set({ phone: `+${digits}`, lastSeenAt: new Date() })
      .where(eq(users.telegramUserId, BigInt(sender.id)))
      .returning({ id: users.id });
    if (!updated) {
      await context.reply('Сначала откройте приложение и начните регистрацию.');
      return;
    }
    await context.reply('Номер получен и добавлен в ваш профиль.');
  });

  // Свободный текст — это либо шаг запроса, либо человек не понял, куда писать.
  bot.on('message:text', async (context) => {
    if (await advanceRequest(context, context.message.text)) return;
    await context.reply(REQUEST_MESSAGES.idle, { reply_markup: mainKeyboard() });
  });

  // Фото и документ приходят с подписью, поэтому она и становится текстом запроса.
  bot.on(['message:photo', 'message:document'], async (context) => {
    const caption = context.message.caption?.trim() ?? '';
    const document = context.message.document;
    const photo = context.message.photo?.at(-1);
    const attachments: RequestAttachment[] = document
      ? [
          {
            fileId: document.file_id,
            kind: 'document',
            ...(document.file_name ? { fileName: document.file_name } : {}),
          },
        ]
      : photo
        ? [{ fileId: photo.file_id, kind: 'photo' }]
        : [];
    if (await advanceRequest(context, caption, attachments)) return;
    await context.reply(REQUEST_MESSAGES.idle, { reply_markup: mainKeyboard() });
  });

  // Кнопки под сообщением рассылки нажимаются в чате с ботом, и обновление о
  // нажатии получает только бот, поэтому отклик возвращается в CRM отсюда.
  bot.on('callback_query:data', async (context) => {
    const data = context.callbackQuery.data;
    if (data === REQUEST_MENU_CALLBACK) {
      await context.answerCallbackQuery();
      await showEventChoice(context);
      return;
    }
    const chosenEvent = parseEventChoiceCallback(data);
    if (chosenEvent) {
      await context.answerCallbackQuery();
      await startRequest(context, chosenEvent);
      return;
    }
    const reply = parseCampaignCallbackData(data);
    if (!reply) {
      await context.answerCallbackQuery();
      return;
    }
    await recordCampaignReply(db, reply);
    const message = CAMPAIGN_REPLY_MESSAGES[reply.action];
    await context.answerCallbackQuery({ text: message });
    await context.reply(message);
  });

  bot.catch((error) => logger.error({ error: error.error }, 'Telegram update failed'));

  notificationWorker = new Worker(
    'notifications',
    async (job) => {
      const data = job.data as {
        type?: string;
        submissionId?: string;
        artifactId?: string;
        requestId?: string;
      };
      if (data.type === 'event_request.created' && data.requestId) {
        await deliverRequestNotice(bot, data.requestId);
        return;
      }
      const deduplicationKey = `${data.type ?? 'unknown'}:${data.submissionId ?? data.artifactId ?? job.id}`;
      const [existing] = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.deduplicationKey, deduplicationKey))
        .limit(1);
      if (existing?.deliveredAt) return;

      let recipient:
        | {
            userId: string;
            telegramUserId: bigint;
            eventTitle: string;
            fileName?: string;
            reason?: string | null;
          }
        | undefined;
      if (data.type === 'submission.ready' && data.submissionId) {
        const [row] = await db
          .select({
            userId: users.id,
            telegramUserId: users.telegramUserId,
            eventTitle: events.title,
          })
          .from(submissions)
          .innerJoin(users, eq(users.id, submissions.userId))
          .innerJoin(events, eq(events.id, submissions.eventId))
          .where(eq(submissions.id, data.submissionId))
          .limit(1);
        recipient = row;
      } else if (data.type === 'artifact.failed' && data.artifactId) {
        const [row] = await db
          .select({
            userId: users.id,
            telegramUserId: users.telegramUserId,
            eventTitle: events.title,
            fileName: artifacts.displayName,
            reason: artifacts.statusReason,
          })
          .from(artifacts)
          .innerJoin(users, eq(users.id, artifacts.userId))
          .innerJoin(events, eq(events.id, artifacts.eventId))
          .where(eq(artifacts.id, data.artifactId))
          .limit(1);
        recipient = row;
      }
      if (!recipient) return;

      if (!existing) {
        await db
          .insert(notificationDeliveries)
          .values({
            userId: recipient.userId,
            eventType: data.type ?? 'unknown',
            deduplicationKey,
          })
          .onConflictDoNothing();
      }
      try {
        const message =
          data.type === 'submission.ready'
            ? `Материалы для «${recipient.eventTitle}» успешно сохранены и проверены.`
            : `Не удалось проверить файл «${recipient.fileName ?? 'файл'}» для «${recipient.eventTitle}». ${recipient.reason ?? 'Попробуйте загрузить его снова.'}`;
        const sent = await bot.api.sendMessage(recipient.telegramUserId.toString(), message, {
          reply_markup: new InlineKeyboard().webApp('Открыть материалы', webAppUrl()),
        });
        await db
          .update(notificationDeliveries)
          .set({
            telegramMessageId: sent.message_id,
            deliveredAt: new Date(),
            errorMessage: null,
          })
          .where(eq(notificationDeliveries.deduplicationKey, deduplicationKey));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db
          .update(notificationDeliveries)
          .set({ errorMessage: message.slice(0, 2_000) })
          .where(eq(notificationDeliveries.deduplicationKey, deduplicationKey));
        // Заблокированный бот повторами не лечится: помечаем адресата и
        // закрываем задание, иначе очередь пять раз бьётся в ту же стену.
        if (isUnreachableRecipientError(message)) {
          await markBotBlocked(db, recipient.userId);
          logger.warn(
            { userId: recipient.userId, deduplicationKey },
            'Recipient is unreachable in Telegram',
          );
          return;
        }
        throw error;
      }
    },
    {
      connection,
      prefix: config.REDIS_PREFIX,
      concurrency: 2,
    },
  );
  notificationWorker.on('failed', (job, error) =>
    logger.error({ jobId: job?.id, error }, 'Notification failed'),
  );
}

/**
 * Запрос уходит каждому администратору отдельным сообщением: недоступность
 * одного адресата не должна лишать остальных уведомления, поэтому ошибка
 * оседает в журнале доставок, а не роняет задание.
 */
async function deliverRequestNotice(telegram: Bot, requestId: string): Promise<void> {
  const notice = await loadRequestNotice(db, requestId);
  if (!notice) return;
  const recipients = await loadNoticeRecipients(db);
  if (recipients.length === 0) {
    logger.warn({ requestId }, 'No administrator has a chat with the bot to receive the request');
    return;
  }
  const text = formatRequestNotice(notice);
  const keyboard = new InlineKeyboard().url(
    'Ответить автору',
    notice.authorUsername
      ? `https://t.me/${notice.authorUsername}`
      : `tg://user?id=${notice.telegramUserId}`,
  );
  for (const recipient of recipients) {
    const deduplicationKey = noticeDeduplicationKey(notice, recipient.userId);
    const shouldSend = await claimNoticeDelivery(db, {
      userId: recipient.userId,
      deduplicationKey,
    });
    if (!shouldSend) continue;
    try {
      const sent = await telegram.api.sendMessage(recipient.telegramUserId, text, {
        reply_markup: keyboard,
      });
      await markNoticeDelivered(db, deduplicationKey, sent.message_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markNoticeFailed(db, deduplicationKey, message);
      if (isUnreachableRecipientError(message)) await markBotBlocked(db, recipient.userId);
      logger.error({ error, requestId, userId: recipient.userId }, 'Request notice failed');
    }
  }
}

function safeSecretEqual(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const webhookHandler = bot ? webhookCallback(bot, 'http') : null;
const server = createServer(async (request, response) => {
  if (request.url === '/health/live') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'bot', configured }));
    return;
  }
  if (request.url === '/health/ready') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: configured ? 'ready' : 'waiting_for_bot_token',
        service: 'bot',
        configured,
      }),
    );
    return;
  }
  if (
    webhookHandler &&
    config.BOT_MODE === 'webhook' &&
    request.method === 'POST' &&
    request.url === config.BOT_WEBHOOK_PATH
  ) {
    const receivedSecret = request.headers['x-telegram-bot-api-secret-token'];
    if (
      config.BOT_WEBHOOK_SECRET &&
      !safeSecretEqual(
        Array.isArray(receivedSecret) ? receivedSecret[0] : receivedSecret,
        config.BOT_WEBHOOK_SECRET,
      )
    ) {
      response.writeHead(403).end();
      return;
    }
    await webhookHandler(request, response);
    return;
  }
  response.writeHead(404).end();
});

/**
 * Первый запрос к Telegram нередко не успевает пройти, пока контейнер поднимает
 * сеть. Без повторов бот остаётся без webhook и меню, а обновления уходят в
 * пустоту, поэтому попытки повторяются, а исчерпав их, процесс завершается —
 * перезапуск контейнера надёжнее наполовину настроенного бота.
 */
async function startTelegram(): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await configureTelegram();
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      const delay = 2_000 * 2 ** (attempt - 1);
      logger.warn({ error, attempt, delay }, 'Telegram setup failed, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function configureTelegram(): Promise<void> {
  if (!bot) {
    logger.warn('TELEGRAM_BOT_TOKEN is not configured; bot is in standby mode');
    return;
  }
  await bot.api.setMyCommands([
    { command: 'start', description: 'Начать' },
    { command: 'request', description: 'Оставить запрос' },
    { command: 'materials', description: 'Мои материалы' },
    { command: 'help', description: 'Помощь' },
  ]);
  await bot.api.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: 'Открыть приложение',
      web_app: { url: webAppUrl() },
    },
  });
  if (config.BOT_MODE === 'webhook') {
    if (!config.BOT_WEBHOOK_SECRET) {
      throw new Error('BOT_WEBHOOK_SECRET is required in webhook mode');
    }
    const webhookUrl = new URL(config.BOT_WEBHOOK_PATH, config.WEB_APP_URL).toString();
    await bot.api.setWebhook(webhookUrl, {
      secret_token: config.BOT_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    logger.info({ webhookUrl }, 'Telegram webhook configured');
  } else {
    await bot.start({
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query'],
    });
  }
}

server.listen(config.BOT_PORT, config.BOT_HOST, () => {
  logger.info({ port: config.BOT_PORT, configured }, 'Bot service listening');
  void startTelegram().catch((error) => {
    logger.error({ error }, 'Telegram setup failed, stopping to let the container restart');
    process.exit(1);
  });
});

let stopping = false;
const close = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Stopping bot');
  await bot?.stop();
  await Promise.allSettled([
    notificationWorker?.close(),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  await Promise.allSettled([connection.quit(), pool.end()]);
  process.exit(0);
};

process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));
