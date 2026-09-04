import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import { Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import pino from 'pino';
import { botEnvironmentSchema, parseEnvironment } from '@cpi/config';
import {
  artifacts,
  createDatabase,
  events,
  feedPosts,
  ledgerEntries,
  ledgerTransactions,
  leaderIdBindings,
  notificationDeliveries,
  outboxEvents,
  pointPrograms,
  storeOrderItems,
  storeOrders,
  storeProducts,
  submissions,
  userMessengerIdentities,
  users,
  walletAccounts,
  walletIntents,
} from '@cpi/db';
import { isPermanentTelegramRecipientError } from './delivery-errors.js';
import {
  createCatalystChatConfiguration,
  matchesTrustedCatalystChatJoinRequest,
  parseCatalystChatConfiguration,
  type CatalystChatConfiguration,
} from './catalyst-chat.js';
import {
  CATALYST_OPENING_BROADCAST_ID,
  CATALYST_OPENING_REMINDER_BROADCAST_ID,
  catalystOpeningBroadcastParts,
  catalystOpeningReminderBroadcastParts,
  type BroadcastButton,
} from './catalyst-opening-broadcast.js';
import {
  isPermanentMaxRecipientError,
  MaxClient,
  maxOpenAppButton,
  type MaxUpdate,
  type MaxUser,
} from './max-client.js';

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
const notificationQueue = bot
  ? new Queue('notifications', {
      connection,
      prefix: config.REDIS_PREFIX,
    })
  : null;
const catalystChatConfigurationKey = `${config.REDIS_PREFIX}:bot:catalyst-chat:v1`;
const maxToken = config.MAX_BOT_TOKEN?.trim();
const maxConfigured = Boolean(
  maxToken && !maxToken.startsWith('CHANGE_ME') && !maxToken.includes('required'),
);
const maxClient = maxConfigured ? new MaxClient(maxToken!, config.MAX_API_BASE) : null;
let maxBotUsername = config.MAX_BOT_USERNAME?.replace(/^@/u, '');
let notificationWorker: Worker | null = null;
let botConfigurationRetryTimer: NodeJS.Timeout | null = null;
let maxConfigurationRetryTimer: NodeJS.Timeout | null = null;

async function loadCatalystChatConfiguration(): Promise<CatalystChatConfiguration | null> {
  const serialized = await connection.get(catalystChatConfigurationKey);
  if (serialized) {
    try {
      return parseCatalystChatConfiguration(serialized);
    } catch (error) {
      logger.error(
        { error: safeErrorSummary(error) },
        'Stored Catalyst Telegram chat configuration is invalid',
      );
      return null;
    }
  }
  return null;
}

interface CatalystChatInvitation {
  id: string | null;
  inviteUrl: string;
  autoApprove: boolean;
}

async function loadCatalystChatInvitation(): Promise<CatalystChatInvitation | null> {
  const chatConfiguration = await loadCatalystChatConfiguration();
  if (chatConfiguration) {
    return {
      id: chatConfiguration.id,
      inviteUrl: chatConfiguration.inviteUrl,
      autoApprove: true,
    };
  }
  if (!config.TELEGRAM_CATALYST_CHAT_INVITE_URL) return null;
  return {
    id: null,
    inviteUrl: config.TELEGRAM_CATALYST_CHAT_INVITE_URL,
    autoApprove: false,
  };
}

async function storeCatalystChatConfiguration(
  configuration: CatalystChatConfiguration,
): Promise<void> {
  await connection.set(catalystChatConfigurationKey, JSON.stringify(configuration));
}

async function enqueueCatalystChatInvitations(
  configuration: CatalystChatConfiguration,
): Promise<number> {
  const queue = notificationQueue;
  if (!queue) throw new Error('Telegram notification queue is unavailable');
  const recipients = await db
    .selectDistinct({ userId: leaderIdBindings.userId })
    .from(leaderIdBindings)
    .innerJoin(userMessengerIdentities, eq(userMessengerIdentities.userId, leaderIdBindings.userId))
    .where(
      and(
        eq(userMessengerIdentities.provider, 'telegram'),
        eq(userMessengerIdentities.canMessage, true),
      ),
    );
  await Promise.all(
    recipients.map((recipient) =>
      queue.add(
        'send-notification',
        {
          type: 'leader_id.telegram_chat_invite',
          userId: recipient.userId,
          invitationId: configuration.id,
        },
        {
          jobId: `catalyst-chat-${configuration.id}-${recipient.userId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 1_000,
        },
      ),
    ),
  );
  return recipients.length;
}

async function enqueueBotUserSync(userId: string, now: Date): Promise<void> {
  await db
    .insert(outboxEvents)
    .values({
      type: 'crm.user.sync',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { userId },
      availableAt: now,
    })
    .onConflictDoUpdate({
      target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
      set: {
        processedAt: null,
        availableAt: now,
        attempts: 0,
        lastError: null,
      },
    });
}

async function updateTelegramIdentity(user: {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
  language_code?: string;
}): Promise<void> {
  const now = new Date();
  const telegramUserId = BigInt(user.id);
  const [databaseUser] = await db
    .insert(users)
    .values({
      telegramUserId,
      telegramUsername: user.username ?? null,
      telegramFirstName: user.first_name,
      telegramLastName: user.last_name ?? null,
      telegramLanguageCode: user.language_code ?? null,
      fullName: null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: users.telegramUserId,
      set: {
        telegramUsername: user.username ?? null,
        telegramFirstName: user.first_name,
        telegramLastName: user.last_name ?? null,
        telegramLanguageCode: user.language_code ?? null,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: users.id, crmPersonId: users.crmPersonId });
  if (!databaseUser) throw new Error('Telegram bot user was not resolved');
  await db
    .insert(userMessengerIdentities)
    .values({
      userId: databaseUser.id,
      provider: 'telegram',
      externalUserId: String(user.id),
      chatId: String(user.id),
      username: user.username ?? null,
      firstName: user.first_name,
      lastName: user.last_name ?? null,
      languageCode: user.language_code ?? null,
      canMessage: true,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userMessengerIdentities.provider, userMessengerIdentities.externalUserId],
      set: {
        chatId: String(user.id),
        username: user.username ?? null,
        firstName: user.first_name,
        lastName: user.last_name ?? null,
        languageCode: user.language_code ?? null,
        canMessage: true,
        lastSeenAt: now,
        updatedAt: now,
      },
    });
  if (!databaseUser.crmPersonId) {
    await enqueueBotUserSync(databaseUser.id, now);
  }
}

function webAppUrl(eventCode?: string): string {
  const url = new URL(config.WEB_APP_URL);
  if (eventCode) url.searchParams.set('event', eventCode);
  return url.toString();
}

function webAppTab(tab: 'home' | 'history' | 'store' | 'mine'): string {
  const url = new URL(webAppUrl());
  url.searchParams.set('tab', tab);
  return url.toString();
}

function webAppPost(postId: string): string {
  const url = new URL(webAppTab('home'));
  url.searchParams.set('post', postId);
  return url.toString();
}

function webAppProduct(productId: string): string {
  const url = new URL(webAppTab('store'));
  url.searchParams.set('product', productId);
  return url.toString();
}

const eventStartMessage =
  'Мероприятие найдено. Откройте карточку: внутри — условия участия, регистрация через Leader-ID (если нужна) и отправка артефакта.';

function maxStartPayload(buttonUrl: string): string | undefined {
  try {
    const url = new URL(buttonUrl);
    const eventCode = url.searchParams.get('event');
    if (eventCode) return `event_${eventCode}`;
    const postId = url.searchParams.get('post');
    if (postId) return `post_${postId}`;
    const productId = url.searchParams.get('product');
    if (productId) return `product_${productId}`;
    const tab = url.searchParams.get('tab');
    if (tab) return `tab_${tab}`;
  } catch {
    return undefined;
  }
  return undefined;
}

function maxAppButton(text: string, buttonUrl: string) {
  const payload = maxStartPayload(buttonUrl);
  return maxOpenAppButton({
    text,
    ...(maxBotUsername ? { botUsername: maxBotUsername } : {}),
    ...(payload ? { payload } : {}),
    fallbackUrl: buttonUrl,
  });
}

function maxUserName(user: MaxUser): {
  firstName: string | null;
  lastName: string | null;
} {
  return {
    firstName: user.first_name?.trim() || user.name?.trim() || null,
    lastName: user.last_name?.trim() || null,
  };
}

async function updateMaxIdentity(
  user: MaxUser,
  canMessage: boolean,
  chatId?: number | null,
): Promise<void> {
  const now = new Date();
  const { firstName, lastName } = maxUserName(user);
  const [updated] = await db
    .update(userMessengerIdentities)
    .set({
      username: user.username,
      firstName,
      lastName,
      canMessage,
      ...(chatId === undefined || chatId === null ? {} : { chatId: String(chatId) }),
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(userMessengerIdentities.provider, 'max'),
        eq(userMessengerIdentities.externalUserId, String(user.user_id)),
      ),
    )
    .returning({ id: userMessengerIdentities.id });
  if (updated || !canMessage) return;

  // MAX может прислать bot_started раньше, чем человек впервые откроет Mini App.
  // Создаём лёгкий общий профиль уже здесь, чтобы пользователь сразу попадал в
  // единую базу и мог получать рассылки. Роль и кошелёк безопасно добавит API
  // при первом подписанном входе; так приветственные баллы не дублируются.
  let createdUserId: string | null = null;
  try {
    createdUserId = await db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ id: userMessengerIdentities.id })
        .from(userMessengerIdentities)
        .where(
          and(
            eq(userMessengerIdentities.provider, 'max'),
            eq(userMessengerIdentities.externalUserId, String(user.user_id)),
          ),
        )
        .limit(1);
      if (existing) return null;
      const [created] = await transaction
        .insert(users)
        .values({ telegramUserId: null, fullName: null, lastSeenAt: now })
        .returning({ id: users.id });
      if (!created) throw new Error('MAX placeholder user was not created');
      const [identity] = await transaction
        .insert(userMessengerIdentities)
        .values({
          userId: created.id,
          provider: 'max',
          externalUserId: String(user.user_id),
          ...(chatId === undefined || chatId === null ? {} : { chatId: String(chatId) }),
          username: user.username,
          firstName,
          lastName,
          canMessage: true,
          lastSeenAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: userMessengerIdentities.id });
      if (!identity) throw new Error('MAX identity was created concurrently');
      return created.id;
    });
  } catch {
    // Параллельные bot_started/message_created могут прийти почти одновременно.
    // Проигравшая транзакция откатывает временного пользователя и обновляет уже
    // созданную идентичность без появления дубля.
    await db
      .update(userMessengerIdentities)
      .set({
        username: user.username,
        firstName,
        lastName,
        canMessage: true,
        ...(chatId === undefined || chatId === null ? {} : { chatId: String(chatId) }),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(userMessengerIdentities.provider, 'max'),
          eq(userMessengerIdentities.externalUserId, String(user.user_id)),
        ),
      );
  }
  if (createdUserId) await enqueueBotUserSync(createdUserId, now);
}

async function sendMaxStart(userId: string, rawPayload?: string | null) {
  if (!maxClient) return;
  if (rawPayload?.startsWith('cmp_')) {
    const rest = rawPayload.slice('cmp_'.length);
    const separator = rest.indexOf('_');
    const recipientId = separator > 0 ? rest.slice(0, separator) : '';
    const action = separator > 0 ? rest.slice(separator + 1) : '';
    const forwarded =
      recipientId && action ? await forwardCampaignReply(recipientId, action) : false;
    await maxClient.sendMessage(
      userId,
      forwarded
        ? action === 'UNSUBSCRIBED'
          ? 'Больше не будем писать. Спасибо, что сказали.'
          : 'Спасибо! Мы получили ваш отклик и свяжемся с вами.'
        : 'Сейчас не получилось учесть отклик, попробуйте позже.',
      maxAppButton('Открыть приложение', webAppUrl()),
    );
    return;
  }
  const eventCode = rawPayload?.startsWith('event_') ? rawPayload.slice(6) : undefined;
  await maxClient.sendMessage(
    userId,
    eventCode
      ? eventStartMessage
      : 'Добро пожаловать в кошелёк Стартап-студии НГУ. Здесь доступны баллы, мероприятия, проекты, материалы и магазин.',
    maxAppButton(eventCode ? 'Открыть мероприятие' : 'Открыть приложение', webAppUrl(eventCode)),
  );
}

async function handleMaxUpdate(update: MaxUpdate): Promise<void> {
  if (!maxClient) return;
  if (update.update_type === 'bot_started') {
    await updateMaxIdentity(update.user, true, update.chat_id);
    await sendMaxStart(String(update.user.user_id), update.payload);
    return;
  }
  if (update.update_type === 'bot_stopped') {
    await updateMaxIdentity(update.user, false, update.chat_id);
    return;
  }
  if (update.update_type === 'message_callback') {
    await updateMaxIdentity(update.callback.user, true);
    const payload = update.callback.payload;
    if (!payload?.startsWith('cmp:')) {
      await maxClient.answerCallback(update.callback.callback_id, 'Готово');
      return;
    }
    const [, recipientId, action] = payload.split(':');
    const forwarded =
      recipientId && action ? await forwardCampaignReply(recipientId, action) : false;
    await maxClient.answerCallback(
      update.callback.callback_id,
      !forwarded
        ? 'Сейчас не получилось, попробуйте позже.'
        : action === 'UNSUBSCRIBED'
          ? 'Больше не будем писать.'
          : 'Спасибо! Мы свяжемся с вами.',
    );
    return;
  }
  if (update.update_type !== 'message_created') return;
  const message = (update as { message?: typeof update.message }).message;
  if (!message) return;
  const sender = message.sender;
  if (!sender || sender.is_bot) return;
  await updateMaxIdentity(sender, true, message.recipient.chat_id);
  const text = message.body.text?.trim().toLowerCase() ?? '';
  if (text.startsWith('/start')) {
    await sendMaxStart(String(sender.user_id), text.split(/\s+/u)[1]);
    return;
  }
  if (text === '/wallet' || text === '/balance') {
    await maxClient.sendMessage(
      String(sender.user_id),
      'Баланс, временные QR, история и магазин доступны в приложении.',
      maxAppButton('Открыть кошелёк', webAppTab('home')),
    );
    return;
  }
  if (text === '/materials') {
    await maxClient.sendMessage(
      String(sender.user_id),
      'Ваши материалы доступны в приложении.',
      maxAppButton('Мои материалы', webAppTab('mine')),
    );
    return;
  }
  if (text === '/help') {
    await maxClient.sendMessage(
      String(sender.user_id),
      'В приложении доступны баланс, мероприятия, проекты, QR, магазин, история и материалы.',
      maxAppButton('Открыть приложение', webAppUrl()),
    );
  }
}

function formatNovosibirskDateTime(value: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Novosibirsk',
  }).format(value);
}

/**
 * Отклик на рассылку CRM. Сообщения рассылает CRM напрямую через Bot API, но
 * нажатия и переходы прилетают только сюда, поэтому бот пересылает их обратно.
 */
async function forwardCampaignReply(recipientId: string, action: string): Promise<boolean> {
  if (!config.CRM_API_URL || !config.CRM_INTEGRATION_TOKEN) {
    logger.warn('Campaign reply received but CRM integration is not configured');
    return false;
  }
  try {
    const response = await fetch(
      new URL('/integrations/campaigns/v1/replies', config.CRM_API_URL),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.CRM_INTEGRATION_TOKEN}`,
        },
        body: JSON.stringify({ recipientId, action }),
      },
    );
    if (!response.ok) throw new Error(`CRM responded ${String(response.status)}`);
    return true;
  } catch (error) {
    logger.error(
      { error: safeErrorSummary(error), recipientId, action },
      'Failed to forward campaign reply to CRM',
    );
    return false;
  }
}

type PointWords = { unitOne: string; unitFew: string; unitMany: string };

function personName(user: {
  fullName: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
  telegramUsername: string | null;
}): string {
  return (
    user.fullName ??
    ([user.telegramFirstName, user.telegramLastName].filter(Boolean).join(' ') ||
      (user.telegramUsername ? `@${user.telegramUsername}` : 'Участник'))
  );
}

function pointUnit(amount: bigint, words: PointWords): string {
  const absolute = amount < 0n ? -amount : amount;
  const mod100 = Number(absolute % 100n);
  const mod10 = Number(absolute % 10n);
  if (mod100 >= 11 && mod100 <= 14) return words.unitMany;
  if (mod10 === 1) return words.unitOne;
  if (mod10 >= 2 && mod10 <= 4) return words.unitFew;
  return words.unitMany;
}

function pointAmount(amount: bigint, words: PointWords): string {
  const absolute = amount < 0n ? -amount : amount;
  return `${absolute.toString()} ${pointUnit(absolute, words)}`;
}

interface PreparedNotification {
  userId: string;
  telegramUserId: bigint | null;
  deduplicationKey: string;
  message: string;
  buttonText?: string;
  buttonUrl?: string;
  buttonKind?: 'web_app' | 'url';
  buttons?: BroadcastButton[];
  allowLegacyTelegramFallback?: boolean;
  targetProvider?: 'telegram' | 'max';
  preferredProvider?: 'telegram' | 'max';
}

async function activeBroadcastRecipients(): Promise<
  Array<{ userId: string; telegramUserId: bigint | null }>
> {
  return db
    .select({ userId: users.id, telegramUserId: users.telegramUserId })
    .from(users)
    .where(eq(users.status, 'active'));
}

async function activeTelegramBroadcastRecipients(): Promise<
  Array<{ userId: string; telegramUserId: bigint | null }>
> {
  return db
    .selectDistinct({ userId: users.id, telegramUserId: users.telegramUserId })
    .from(users)
    .innerJoin(
      userMessengerIdentities,
      and(
        eq(userMessengerIdentities.userId, users.id),
        eq(userMessengerIdentities.provider, 'telegram'),
        eq(userMessengerIdentities.canMessage, true),
      ),
    )
    .where(eq(users.status, 'active'));
}

function addBroadcastNotifications(
  target: PreparedNotification[],
  recipients: Array<{ userId: string; telegramUserId: bigint | null }>,
  input: {
    eventType: string;
    aggregateId: string;
    message: string;
    buttonText: string;
    buttonUrl: string;
  },
): void {
  for (const recipient of recipients) {
    target.push({
      ...recipient,
      deduplicationKey: `${input.eventType}:${input.aggregateId}:${recipient.userId}`,
      message: input.message,
      buttonText: input.buttonText,
      buttonUrl: input.buttonUrl,
    });
  }
}

function notificationButtons(notification: PreparedNotification): BroadcastButton[] {
  if (notification.buttons) return notification.buttons;
  if (!notification.buttonText || !notification.buttonUrl) return [];
  return [
    {
      text: notification.buttonText,
      url: notification.buttonUrl,
      kind: notification.buttonKind ?? 'web_app',
    },
  ];
}

function telegramReplyMarkup(notification: PreparedNotification): InlineKeyboard | undefined {
  const buttons = notificationButtons(notification);
  if (buttons.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  for (const [index, button] of buttons.entries()) {
    if (index > 0) keyboard.row();
    if (button.kind === 'url') keyboard.url(button.text, button.url);
    else keyboard.webApp(button.text, button.url);
  }
  return keyboard;
}

interface DeliveryEndpoint {
  provider: 'telegram' | 'max';
  externalUserId: string;
}

async function deliveryEndpoints(notification: PreparedNotification): Promise<DeliveryEndpoint[]> {
  const rows = await db
    .select({
      provider: userMessengerIdentities.provider,
      externalUserId: userMessengerIdentities.externalUserId,
    })
    .from(userMessengerIdentities)
    .where(
      and(
        eq(userMessengerIdentities.userId, notification.userId),
        eq(userMessengerIdentities.canMessage, true),
      ),
    );
  let endpoints = rows.filter(
    (row) =>
      (!notification.targetProvider || row.provider === notification.targetProvider) &&
      ((row.provider === 'telegram' && Boolean(bot)) ||
        (row.provider === 'max' && Boolean(maxClient))),
  );
  if (notification.preferredProvider) {
    const preferredEndpoints = endpoints.filter(
      (endpoint) => endpoint.provider === notification.preferredProvider,
    );
    if (preferredEndpoints.length > 0) endpoints = preferredEndpoints;
  }
  if (
    endpoints.length === 0 &&
    notification.allowLegacyTelegramFallback !== false &&
    notification.targetProvider !== 'max' &&
    notification.telegramUserId !== null &&
    bot
  ) {
    return [
      {
        provider: 'telegram',
        externalUserId: notification.telegramUserId.toString(),
      },
    ];
  }
  return endpoints;
}

if (bot) {
  bot.use(async (context, next) => {
    if (context.from && !context.from.is_bot && !context.update.chat_join_request) {
      await updateTelegramIdentity(context.from);
    }
    await next();
  });
  bot.command('start', async (context) => {
    const rawPayload = context.match?.trim();
    // Ссылка из email-рассылки: в письме нет callback-кнопок, поэтому отклик
    // приходит стартовым payload — и заодно приводит человека в бот.
    if (rawPayload?.startsWith('cmp_')) {
      // Действие MORE_INFO само содержит подчёркивание, поэтому режем по первому.
      const rest = rawPayload.slice('cmp_'.length);
      const separator = rest.indexOf('_');
      const recipientId = separator > 0 ? rest.slice(0, separator) : '';
      const action = separator > 0 ? rest.slice(separator + 1) : '';
      const forwarded =
        recipientId && action ? await forwardCampaignReply(recipientId, action) : false;
      await context.reply(
        forwarded
          ? action === 'UNSUBSCRIBED'
            ? 'Больше не будем писать. Спасибо, что сказали.'
            : 'Спасибо! Мы получили ваш отклик и свяжемся с вами.'
          : 'Сейчас не получилось учесть отклик, попробуйте позже.',
        {
          reply_markup: new InlineKeyboard().webApp('Открыть приложение', webAppUrl()),
        },
      );
      return;
    }
    const eventCode = rawPayload?.startsWith('event_') ? rawPayload.slice(6) : rawPayload;
    const keyboard = new InlineKeyboard().webApp(
      eventCode ? 'Открыть мероприятие' : 'Открыть приложение',
      webAppUrl(eventCode || undefined),
    );
    await context.reply(
      eventCode
        ? eventStartMessage
        : 'Добро пожаловать в кошелёк Стартап-студии НГУ. Здесь вы получаете баллы за мероприятия, обмениваетесь ими по QR и тратите в магазине. Новым участникам начисляются приветственные 100 баллов.',
      { reply_markup: keyboard },
    );
  });
  bot.command(['wallet', 'balance'], async (context) => {
    await context.reply('Баланс, временные QR, история и магазин доступны в приложении.', {
      reply_markup: new InlineKeyboard().webApp('Открыть кошелёк', webAppTab('home')),
    });
  });
  bot.command('materials', async (context) => {
    await context.reply('Ваши материалы доступны в приложении.', {
      reply_markup: new InlineKeyboard().webApp('Мои материалы', webAppTab('mine')),
    });
  });
  bot.command('help', async (context) => {
    await context.reply(
      'В приложении есть пять главных разделов: баланс, мероприятия, QR, магазин и история. Показывайте только свежий QR: он одноразовый и быстро истекает. Перед переводом всегда проверяйте имя и сумму.',
      {
        reply_markup: new InlineKeyboard().webApp('Открыть приложение', webAppUrl()),
      },
    );
  });
  bot.command('setup_catalyst_chat', async (context) => {
    const sender = context.from;
    if (!sender || !config.SUPERADMIN_TELEGRAM_IDS.includes(String(sender.id))) {
      await context.reply('Эта команда доступна только суперадминистратору Catalyst.');
      return;
    }
    if (context.chat.type !== 'group' && context.chat.type !== 'supergroup') {
      await context.reply('Отправьте эту команду внутри группы участников Catalyst.');
      return;
    }

    const callerMember = await bot.api.getChatMember(context.chat.id, sender.id);
    if (callerMember.status !== 'creator' && callerMember.status !== 'administrator') {
      await context.reply('Настроить чат может только его администратор.');
      return;
    }
    const botMember = await bot.api.getChatMember(context.chat.id, context.me.id);
    const botCanInvite =
      botMember.status === 'creator' ||
      (botMember.status === 'administrator' && botMember.can_invite_users);
    if (!botCanInvite) {
      await context.reply(
        'Дайте боту право приглашать пользователей и одобрять заявки, затем повторите команду.',
      );
      return;
    }

    const previousConfiguration = await loadCatalystChatConfiguration();
    const invite = await bot.api.createChatInviteLink(context.chat.id, {
      name: 'Catalyst Leader-ID',
      creates_join_request: true,
    });
    const nextConfiguration = createCatalystChatConfiguration(
      String(context.chat.id),
      invite.invite_link,
    );
    try {
      await storeCatalystChatConfiguration(nextConfiguration);
    } catch (error) {
      await bot.api
        .revokeChatInviteLink(context.chat.id, invite.invite_link)
        .catch(() => undefined);
      throw error;
    }
    if (
      previousConfiguration &&
      previousConfiguration.chatId === nextConfiguration.chatId &&
      previousConfiguration.inviteUrl !== nextConfiguration.inviteUrl
    ) {
      await bot.api
        .revokeChatInviteLink(context.chat.id, previousConfiguration.inviteUrl)
        .catch((error) =>
          logger.warn(
            { error: safeErrorSummary(error), chatId: nextConfiguration.chatId },
            'Previous Catalyst chat invite could not be revoked',
          ),
        );
    }

    const queued = await enqueueCatalystChatInvitations(nextConfiguration);
    await context.reply(
      `Готово. Бот создал ссылку с заявкой на вступление и отправляет новую кнопку ${String(queued)} подтверждённым Telegram-пользователям с Leader-ID. Заявки по этой кнопке будут одобряться автоматически.`,
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
  bot.on('callback_query:data', async (context) => {
    const data = context.callbackQuery.data;
    if (!data.startsWith('cmp:')) return;
    const [, recipientId, action] = data.split(':');
    if (!recipientId || !action) {
      await context.answerCallbackQuery();
      return;
    }
    const forwarded = await forwardCampaignReply(recipientId, action);
    await context.answerCallbackQuery({
      text: !forwarded
        ? 'Сейчас не получилось, попробуйте позже.'
        : action === 'UNSUBSCRIBED'
          ? 'Больше не будем писать. Спасибо, что сказали.'
          : 'Спасибо! Мы свяжемся с вами.',
    });
  });

  bot.on('chat_join_request', async (context) => {
    const request = context.chatJoinRequest;
    const chatConfiguration = await loadCatalystChatConfiguration();
    if (
      !matchesTrustedCatalystChatJoinRequest(
        chatConfiguration,
        {
          chatId: config.TELEGRAM_CATALYST_CHAT_ID,
          inviteUrl: config.TELEGRAM_CATALYST_CHAT_INVITE_URL,
        },
        {
          chatId: String(request.chat.id),
          inviteUrl: request.invite_link?.invite_link,
        },
      )
    ) {
      return;
    }

    const [knownUser] = await db
      .select({ userId: users.id })
      .from(userMessengerIdentities)
      .innerJoin(users, eq(users.id, userMessengerIdentities.userId))
      .where(
        and(
          eq(userMessengerIdentities.provider, 'telegram'),
          eq(userMessengerIdentities.externalUserId, String(request.from.id)),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);
    if (!knownUser) return;

    await bot.api.approveChatJoinRequest(request.chat.id, request.from.id);
    logger.info(
      { chatId: String(request.chat.id), userId: knownUser.userId },
      'Approved Catalyst chat join request for an active bot user',
    );
  });

  bot.catch((error) =>
    logger.error({ error: safeErrorSummary(error.error) }, 'Telegram update failed'),
  );
}

if (bot || maxClient) {
  notificationWorker = new Worker(
    'notifications',
    async (job) => {
      const data = job.data as {
        type?: string;
        userId?: string;
        invitationId?: string;
        submissionId?: string;
        artifactId?: string;
        transactionId?: string;
        intentId?: string;
        orderId?: string;
        eventId?: string;
        postId?: string;
        productId?: string;
        broadcastId?: string;
      };
      const notifications: PreparedNotification[] = [];
      if (data.type === 'leader_id.telegram_chat_invite' && data.userId) {
        const invitation = await loadCatalystChatInvitation();
        if (!invitation) return;
        if (data.invitationId && data.invitationId !== invitation.id) return;
        const [row] = await db
          .select({
            userId: users.id,
            telegramUserId: users.telegramUserId,
          })
          .from(users)
          .innerJoin(leaderIdBindings, eq(leaderIdBindings.userId, users.id))
          .where(and(eq(users.id, data.userId), eq(users.status, 'active')))
          .limit(1);
        if (row) {
          notifications.push({
            userId: row.userId,
            telegramUserId: row.telegramUserId,
            deduplicationKey: invitation.autoApprove
              ? `leader_id.telegram_chat_invite:${invitation.id}:${row.userId}`
              : `leader_id.telegram_chat_invite:${row.userId}`,
            message: invitation.autoApprove
              ? 'Leader-ID подключён. Нажмите кнопку, чтобы вступить в закрытый чат участников Catalyst. Бот проверит привязку и сразу одобрит заявку.'
              : 'Leader-ID подключён. Нажмите кнопку, чтобы вступить в чат участников Catalyst.',
            buttonText: invitation.autoApprove ? 'Подать заявку в чат' : 'Вступить в чат',
            buttonUrl: invitation.inviteUrl,
            buttonKind: 'url',
            targetProvider: 'telegram',
          });
        }
      } else if (data.type === 'submission.ready' && data.submissionId) {
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
        if (row) {
          notifications.push({
            userId: row.userId,
            telegramUserId: row.telegramUserId,
            deduplicationKey: `submission.ready:${data.submissionId}:${row.userId}`,
            message: `Артефакты для «${row.eventTitle}» успешно сохранены и проверены.`,
            buttonText: 'Мои артефакты',
            buttonUrl: webAppTab('mine'),
          });
        }
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
        if (row) {
          notifications.push({
            userId: row.userId,
            telegramUserId: row.telegramUserId,
            deduplicationKey: `artifact.failed:${data.artifactId}:${row.userId}`,
            message: `Не удалось проверить файл «${row.fileName ?? 'файл'}» для «${row.eventTitle}». ${row.reason ?? 'Попробуйте загрузить его снова.'}`,
            buttonText: 'Открыть артефакты',
            buttonUrl: webAppTab('mine'),
          });
        }
      } else if (data.type === 'wallet.intent.created' && data.intentId) {
        const [row] = await db
          .select({
            intent: walletIntents,
            recipient: users,
            program: pointPrograms,
          })
          .from(walletIntents)
          .innerJoin(users, eq(users.id, walletIntents.requiredConfirmerUserId))
          .innerJoin(pointPrograms, eq(pointPrograms.id, walletIntents.programId))
          .where(eq(walletIntents.id, data.intentId))
          .limit(1);
        if (row?.intent.status === 'awaiting_owner_confirmation') {
          const [initiator] = await db
            .select()
            .from(users)
            .where(eq(users.id, row.intent.initiatorUserId))
            .limit(1);
          notifications.push({
            userId: row.recipient.id,
            telegramUserId: row.recipient.telegramUserId,
            deduplicationKey: `wallet.intent.created:${data.intentId}:${row.recipient.id}`,
            message: `${initiator ? personName(initiator) : 'Сотрудник'} запросил списание ${pointAmount(row.intent.amount, row.program)}.${row.intent.reason ? `\nОснование: ${row.intent.reason}` : ''}\nБаланс не изменится, пока вы сами не подтвердите запрос.`,
            buttonText: 'Проверить запрос',
            buttonUrl: webAppTab('home'),
          });
        }
      } else if (data.type === 'wallet.transaction.posted' && data.transactionId) {
        const rows = await db
          .select({
            entry: ledgerEntries,
            transaction: ledgerTransactions,
            account: walletAccounts,
            user: users,
            program: pointPrograms,
          })
          .from(ledgerEntries)
          .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
          .innerJoin(walletAccounts, eq(walletAccounts.id, ledgerEntries.accountId))
          .innerJoin(users, eq(users.id, walletAccounts.userId))
          .innerJoin(pointPrograms, eq(pointPrograms.id, ledgerTransactions.programId))
          .where(
            and(
              eq(ledgerTransactions.id, data.transactionId),
              eq(walletAccounts.ownerKind, 'user'),
            ),
          );
        for (const row of rows) {
          if (row.transaction.kind === 'store_purchase') continue;
          const positive = row.entry.delta > 0n;
          const otherUser = rows.find((candidate) => candidate.user.id !== row.user.id)?.user;
          const labels: Record<string, string> = {
            welcome_grant: 'Приветственное начисление',
            staff_credit: 'Начисление сотрудником',
            staff_debit: 'Списание, подтверждённое вами',
            artifact_reward: 'Награда за артефакт',
            admin_adjustment: 'Административная корректировка',
            season_opening: 'Открытие сезона',
            reversal: 'Обратная операция',
          };
          const operation =
            row.transaction.kind === 'p2p_transfer' && otherUser
              ? positive
                ? `Перевод от ${personName(otherUser)}`
                : `Перевод для ${personName(otherUser)}`
              : (labels[row.transaction.kind] ?? 'Операция с баллами');
          notifications.push({
            userId: row.user.id,
            telegramUserId: row.user.telegramUserId,
            deduplicationKey: `wallet.transaction.posted:${data.transactionId}:${row.user.id}`,
            message: `${positive ? 'Зачислено' : 'Списано'} ${pointAmount(row.entry.delta, row.program)}.\n${operation}${row.transaction.reason ? `: ${row.transaction.reason}` : ''}`,
            buttonText: 'Открыть историю',
            buttonUrl: webAppTab('history'),
          });
        }
      } else if (data.type?.startsWith('store.order.') && data.orderId) {
        const [row] = await db
          .select({ order: storeOrders, user: users, program: pointPrograms })
          .from(storeOrders)
          .innerJoin(users, eq(users.id, storeOrders.userId))
          .innerJoin(pointPrograms, eq(pointPrograms.id, storeOrders.programId))
          .where(eq(storeOrders.id, data.orderId))
          .limit(1);
        if (row) {
          const items = await db
            .select({
              title: storeOrderItems.titleSnapshot,
              quantity: storeOrderItems.quantity,
            })
            .from(storeOrderItems)
            .where(eq(storeOrderItems.orderId, row.order.id));
          const title = items
            .map((item) => `${item.title}${item.quantity > 1 ? ` × ${item.quantity}` : ''}`)
            .join(', ');
          const messages: Record<string, string> = {
            'store.order.paid': `Заказ «${title}» оплачен: ${pointAmount(row.order.totalPoints, row.program)}. Баллы списаны без возврата; теперь оставьте заявку на выдачу.`,
            'store.order.pickup_requested': `Заявка на выдачу «${title}» принята.`,
            'store.order.ready_for_pickup': `Заказ «${title}» готов к выдаче.`,
            'store.order.fulfilled': `Заказ «${title}» выдан. Спасибо!`,
          };
          const message = messages[data.type];
          if (message) {
            notifications.push({
              userId: row.user.id,
              telegramUserId: row.user.telegramUserId,
              deduplicationKey: `${data.type}:${data.orderId}:${row.user.id}`,
              message,
              buttonText: 'Мои заявки',
              buttonUrl: webAppTab('store'),
            });
          }
        }
      } else if (
        data.type === 'broadcast.telegram.catalyst_opening' &&
        (data.broadcastId === CATALYST_OPENING_BROADCAST_ID ||
          data.broadcastId === CATALYST_OPENING_REMINDER_BROADCAST_ID)
      ) {
        const recipients = await activeTelegramBroadcastRecipients();
        const parts =
          data.broadcastId === CATALYST_OPENING_BROADCAST_ID
            ? catalystOpeningBroadcastParts(webAppUrl())
            : catalystOpeningReminderBroadcastParts();
        for (const recipient of recipients) {
          for (const part of parts) {
            notifications.push({
              ...recipient,
              deduplicationKey: `${data.type}:${data.broadcastId}:${part.id}:${recipient.userId}`,
              message: part.message,
              ...(part.buttons ? { buttons: part.buttons } : {}),
              allowLegacyTelegramFallback: false,
              targetProvider: 'telegram',
            });
          }
        }
        logger.info(
          {
            broadcastId: data.broadcastId,
            recipients: recipients.length,
            messages: notifications.length,
          },
          'Prepared Catalyst opening broadcast',
        );
      } else if (
        (data.type === 'broadcast.event.published' ||
          data.type === 'broadcast.event.uploads_opened') &&
        data.eventId
      ) {
        const [event] = await db.select().from(events).where(eq(events.id, data.eventId)).limit(1);
        const now = new Date();
        const active =
          event && !event.deletedAt && (event.status === 'published' || event.status === 'running');
        const acceptanceOpen =
          active && event.acceptUploadsFrom <= now && event.acceptUploadsUntil >= now;
        if (active && (data.type !== 'broadcast.event.uploads_opened' || acceptanceOpen)) {
          const uploadNotice = data.type === 'broadcast.event.uploads_opened';
          addBroadcastNotifications(notifications, await activeBroadcastRecipients(), {
            eventType: data.type,
            aggregateId: data.broadcastId ?? event.id,
            message: uploadNotice
              ? `На мероприятии «${event.title}» начался приём материалов.\nОтправьте артефакт через приложение.`
              : `Новое мероприятие — «${event.title}».\nНачало: ${formatNovosibirskDateTime(event.startsAt)}.${acceptanceOpen ? '\nПриём материалов уже открыт.' : ''}`,
            buttonText: uploadNotice ? 'Отправить материал' : 'Посмотреть',
            buttonUrl: webAppUrl(event.shortCode),
          });
        }
      } else if (data.type === 'broadcast.feed.published' && data.postId) {
        const [post] = await db
          .select()
          .from(feedPosts)
          .where(eq(feedPosts.id, data.postId))
          .limit(1);
        const now = new Date();
        if (
          post?.kind === 'news' &&
          post.status === 'published' &&
          post.audience === 'all' &&
          (!post.publishedAt || post.publishedAt <= now)
        ) {
          const summary = post.summary?.replace(/\s+/g, ' ').trim().slice(0, 500);
          addBroadcastNotifications(notifications, await activeBroadcastRecipients(), {
            eventType: data.type,
            aggregateId: data.broadcastId ?? post.id,
            message: `Новая публикация — «${post.title}».${summary ? `\n${summary}` : ''}`,
            buttonText: 'Посмотреть',
            buttonUrl: webAppPost(post.id),
          });
        }
      } else if (data.type === 'broadcast.product.published' && data.productId) {
        const [product] = await db
          .select()
          .from(storeProducts)
          .where(eq(storeProducts.id, data.productId))
          .limit(1);
        const now = new Date();
        if (
          product?.status === 'published' &&
          !product.deletedAt &&
          (!product.availableFrom || product.availableFrom <= now) &&
          (!product.availableUntil || product.availableUntil >= now)
        ) {
          addBroadcastNotifications(notifications, await activeBroadcastRecipients(), {
            eventType: data.type,
            aggregateId: data.broadcastId ?? product.id,
            message: `В магазине появился новый товар — «${product.title}».\nЦена: ${product.price.toString()} баллов.`,
            buttonText: 'Посмотреть товар',
            buttonUrl: webAppProduct(product.id),
          });
        }
      }

      let retryableBroadcastFailures = 0;
      let permanentBroadcastFailures = 0;
      for (const notification of notifications) {
        const endpoints = await deliveryEndpoints(notification);
        for (const endpoint of endpoints) {
          const deduplicationKey = `${notification.deduplicationKey}:${endpoint.provider}`;
          const [existing] = await db
            .select()
            .from(notificationDeliveries)
            .where(eq(notificationDeliveries.deduplicationKey, deduplicationKey))
            .limit(1);
          if (existing?.deliveredAt) continue;
          if (!existing) {
            await db
              .insert(notificationDeliveries)
              .values({
                userId: notification.userId,
                eventType: data.type ?? 'unknown',
                deduplicationKey,
                messengerProvider: endpoint.provider,
              })
              .onConflictDoNothing();
          }
          try {
            let externalMessageId: string;
            let telegramMessageId: number | null = null;
            if (endpoint.provider === 'telegram') {
              if (!bot) continue;
              const replyMarkup = telegramReplyMarkup(notification);
              const sent = await bot.api.sendMessage(
                endpoint.externalUserId,
                notification.message,
                {
                  ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                },
              );
              telegramMessageId = sent.message_id;
              externalMessageId = String(sent.message_id);
            } else {
              if (!maxClient) continue;
              const [button] = notificationButtons(notification);
              const sent = await maxClient.sendMessage(
                endpoint.externalUserId,
                notification.message,
                button
                  ? button.kind === 'url'
                    ? maxOpenAppButton({ text: button.text, fallbackUrl: button.url })
                    : maxAppButton(button.text, button.url)
                  : undefined,
              );
              externalMessageId = sent.body.mid;
            }
            await db
              .update(notificationDeliveries)
              .set({
                messengerProvider: endpoint.provider,
                externalMessageId,
                telegramMessageId,
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
            const permanent =
              endpoint.provider === 'telegram'
                ? isPermanentTelegramRecipientError(error)
                : isPermanentMaxRecipientError(error);
            if (permanent) {
              await db
                .update(userMessengerIdentities)
                .set({ canMessage: false, updatedAt: new Date() })
                .where(
                  and(
                    eq(userMessengerIdentities.provider, endpoint.provider),
                    eq(userMessengerIdentities.externalUserId, endpoint.externalUserId),
                  ),
                );
            }
            if (data.type?.startsWith('broadcast.')) {
              if (permanent) permanentBroadcastFailures += 1;
              else retryableBroadcastFailures += 1;
              logger.warn(
                {
                  error: safeErrorSummary(error),
                  userId: notification.userId,
                  provider: endpoint.provider,
                  eventType: data.type,
                  retryable: !permanent,
                },
                'Broadcast delivery failed',
              );
              continue;
            }
            throw error;
          }
        }
      }
      if (permanentBroadcastFailures > 0) {
        logger.info(
          {
            eventType: data.type,
            permanentFailures: permanentBroadcastFailures,
          },
          'Broadcast completed with unreachable recipients',
        );
      }
      if (retryableBroadcastFailures > 0) {
        throw new Error(
          `Broadcast failed for ${String(retryableBroadcastFailures)} retryable recipient(s)`,
        );
      }
    },
    {
      connection,
      prefix: config.REDIS_PREFIX,
      concurrency: 2,
    },
  );
  notificationWorker.on('failed', (job, error) =>
    logger.error({ jobId: job?.id, error: safeErrorSummary(error) }, 'Notification failed'),
  );
}

function safeSecretEqual(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const chunkValue: unknown = chunk;
    if (typeof chunkValue !== 'string' && !(chunkValue instanceof Uint8Array)) {
      throw new Error('Webhook body contains unsupported data');
    }
    const buffer = Buffer.from(chunkValue);
    size += buffer.length;
    if (size > 1_048_576) throw new Error('Webhook body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const webhookHandler = bot ? webhookCallback(bot, 'http') : null;
async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.url === '/health/live') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: 'ok',
        service: 'bot',
        configured: { telegram: configured, max: maxConfigured },
      }),
    );
    return;
  }
  if (request.url === '/health/ready') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: configured || maxConfigured ? 'ready' : 'waiting_for_bot_token',
        service: 'bot',
        configured: { telegram: configured, max: maxConfigured },
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
  if (maxClient && request.method === 'POST' && request.url === config.MAX_WEBHOOK_PATH) {
    const receivedSecret = request.headers['x-max-bot-api-secret'];
    if (
      !safeSecretEqual(
        Array.isArray(receivedSecret) ? receivedSecret[0] : receivedSecret,
        config.MAX_WEBHOOK_SECRET,
      )
    ) {
      response.writeHead(403).end();
      return;
    }
    try {
      const update = (await readJsonBody(request)) as MaxUpdate;
      if (!update || typeof update.update_type !== 'string') {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      void handleMaxUpdate(update).catch((error) =>
        logger.error(
          { error: safeErrorSummary(error), updateType: update.update_type },
          'MAX update failed',
        ),
      );
    } catch (error) {
      logger.warn({ error: safeErrorSummary(error) }, 'Invalid MAX webhook');
      response.writeHead(400).end();
    }
    return;
  }
  response.writeHead(404).end();
}

const server = createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error) => {
    logger.error(
      {
        error: safeErrorSummary(error),
        method: request.method,
        path: request.url,
      },
      'Bot HTTP request failed',
    );
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json' });
    }
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: 'internal_error' }));
    }
  });
});

function redactSecrets(value: string): string {
  let redacted = value
    .replace(/api\.telegram\.org\/bot[^/\s]+/giu, 'api.telegram.org/bot[REDACTED]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED]')
    .replace(/https:\/\/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/giu, '[REDACTED]');
  for (const secret of [
    token,
    maxToken,
    config.TELEGRAM_CATALYST_CHAT_INVITE_URL,
    config.BOT_WEBHOOK_SECRET,
    config.MAX_WEBHOOK_SECRET,
    config.CRM_INTEGRATION_TOKEN,
  ]) {
    if (secret && secret.length >= 4) {
      redacted = redacted.replaceAll(secret, '[REDACTED]');
    }
  }
  return redacted;
}

function safeErrorSummary(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? {
        name: redactSecrets(error.name),
        message: redactSecrets(error.message),
      }
    : { name: 'Error', message: redactSecrets(String(error)) };
}

async function configureTelegramBot(): Promise<void> {
  if (!bot) return;
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть приложение' },
    { command: 'wallet', description: 'Мой баланс и QR' },
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
      allowed_updates: ['message', 'callback_query', 'chat_join_request'],
      drop_pending_updates: false,
    });
    logger.info({ webhookUrl }, 'Telegram webhook configured');
  } else {
    await bot.start({ drop_pending_updates: false });
  }
}

function startTelegramBotConfiguration(attempt = 1): void {
  void configureTelegramBot().catch((error) => {
    const retryDelayMs = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
    logger.error(
      {
        error: safeErrorSummary(error),
        attempt,
        retryDelayMs,
      },
      'Telegram bot configuration failed; retry scheduled',
    );
    botConfigurationRetryTimer = setTimeout(
      () => startTelegramBotConfiguration(attempt + 1),
      retryDelayMs,
    );
    botConfigurationRetryTimer.unref();
  });
}

async function configureMaxBot(): Promise<void> {
  if (!maxClient) return;
  if (!config.MAX_WEBHOOK_SECRET) {
    throw new Error('MAX_WEBHOOK_SECRET is required when MAX is configured');
  }
  const me = await maxClient.getMe();
  maxBotUsername = maxBotUsername ?? me.username?.replace(/^@/u, '') ?? undefined;
  const webhookUrl = new URL(config.MAX_WEBHOOK_PATH, config.WEB_APP_URL).toString();
  await maxClient.subscribe({
    url: webhookUrl,
    secret: config.MAX_WEBHOOK_SECRET,
    updateTypes: ['bot_started', 'bot_stopped', 'message_created', 'message_callback'],
  });
  try {
    await maxClient.setCommands([
      { name: 'start', description: 'Открыть приложение' },
      { name: 'wallet', description: 'Мой баланс и QR' },
      { name: 'materials', description: 'Мои материалы' },
      { name: 'help', description: 'Помощь' },
    ]);
  } catch (error) {
    logger.warn(
      { error: safeErrorSummary(error) },
      'MAX commands could not be updated; webhook remains active',
    );
  }
  logger.info(
    { webhookUrl, botId: me.user_id, username: maxBotUsername },
    'MAX webhook configured',
  );
}

function startMaxBotConfiguration(attempt = 1): void {
  void configureMaxBot().catch((error) => {
    const retryDelayMs = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
    logger.error(
      { error: safeErrorSummary(error), attempt, retryDelayMs },
      'MAX bot configuration failed; retry scheduled',
    );
    maxConfigurationRetryTimer = setTimeout(
      () => startMaxBotConfiguration(attempt + 1),
      retryDelayMs,
    );
    maxConfigurationRetryTimer.unref();
  });
}

server.listen(config.BOT_PORT, config.BOT_HOST, () => {
  logger.info(
    {
      port: config.BOT_PORT,
      configured: { telegram: configured, max: maxConfigured },
    },
    'Bot service listening',
  );
  if (!bot) {
    logger.warn('TELEGRAM_BOT_TOKEN is not configured');
  } else {
    startTelegramBotConfiguration();
  }
  if (!maxClient) logger.warn('MAX_BOT_TOKEN is not configured');
  else startMaxBotConfiguration();
});

let stopping = false;
const close = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Stopping bot');
  if (botConfigurationRetryTimer) clearTimeout(botConfigurationRetryTimer);
  if (maxConfigurationRetryTimer) clearTimeout(maxConfigurationRetryTimer);
  await bot?.stop();
  await Promise.allSettled([
    notificationQueue?.close(),
    notificationWorker?.close(),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  await Promise.allSettled([connection.quit(), pool.end()]);
  process.exit(0);
};

process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));
