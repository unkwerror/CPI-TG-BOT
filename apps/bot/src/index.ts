import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
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

function webAppUrl(eventCode?: string): string {
  const url = new URL(config.WEB_APP_URL);
  if (eventCode) url.searchParams.set('event', eventCode);
  return url.toString();
}

if (bot) {
  bot.command('start', async (context) => {
    const rawPayload = context.match?.trim();
    const eventCode = rawPayload?.startsWith('event_') ? rawPayload.slice(6) : rawPayload;
    const keyboard = new InlineKeyboard().webApp(
      eventCode ? 'Открыть мероприятие' : 'Открыть приложение',
      webAppUrl(eventCode || undefined),
    );
    await context.reply(
      eventCode
        ? 'Мероприятие найдено. Откройте приложение, чтобы отправить материалы.'
        : 'Здравствуйте! Здесь можно передать материалы с мероприятия — файлы, ссылки и заметки.',
      { reply_markup: keyboard },
    );
  });
  bot.command('materials', async (context) => {
    await context.reply('Ваши материалы доступны в приложении.', {
      reply_markup: new InlineKeyboard().webApp('Мои материалы', `${webAppUrl()}?tab=mine`),
    });
  });
  bot.command('help', async (context) => {
    await context.reply(
      'Нажмите «Открыть приложение», выберите мероприятие и добавьте текст, ссылку или файлы. При ошибке загрузку можно повторить.',
      { reply_markup: new InlineKeyboard().webApp('Открыть приложение', webAppUrl()) },
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
  bot.catch((error) => logger.error({ error: error.error }, 'Telegram update failed'));

  notificationWorker = new Worker(
    'notifications',
    async (job) => {
      const data = job.data as {
        type?: string;
        submissionId?: string;
        artifactId?: string;
      };
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

server.listen(config.BOT_PORT, config.BOT_HOST, async () => {
  logger.info({ port: config.BOT_PORT, configured }, 'Bot service listening');
  if (!bot) {
    logger.warn('TELEGRAM_BOT_TOKEN is not configured; bot is in standby mode');
    return;
  }
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть приложение' },
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
    await bot.start({ drop_pending_updates: false });
  }
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
