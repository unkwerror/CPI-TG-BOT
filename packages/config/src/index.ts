import { z } from 'zod';

const integer = (fallback: number, minimum = 0) =>
  z.coerce.number().int().min(minimum).default(fallback);

const boolean = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true' || value === '1');

const commaSeparated = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const optionalSecret = (minimum: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().trim().min(minimum).optional(),
  );

const optionalTelegramInviteUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        (url.hostname === 't.me' || url.hostname === 'telegram.me') &&
        (url.pathname.startsWith('/+') || url.pathname.startsWith('/joinchat/'))
      );
    }, 'Ожидается приватная ссылка-приглашение Telegram')
    .optional(),
);

const optionalTelegramChatId = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^-\d+$/u, 'Ожидается отрицательный идентификатор Telegram-чата')
    .optional(),
);

const nodeEnvironment = z.enum(['development', 'test', 'production']).default('development');

const storagePrefix = z
  .string()
  .trim()
  .default('locker/')
  .transform((value) => value.replace(/^\/+|\/+$/gu, ''))
  .pipe(
    z
      .string()
      .min(1, 'S3_PREFIX не может быть пустым')
      .regex(
        /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u,
        'S3_PREFIX содержит недопустимый или traversal-сегмент',
      ),
  )
  .transform((value) => `${value}/`);

const databaseSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

const redisSchema = z.object({
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
});

const s3Schema = z.object({
  S3_ENDPOINT: z.url().default('http://localhost:9000'),
  /**
   * Домен, через который за файлами ходит браузер. Пустая строка — ходить прямо
   * в хранилище; в проде туда подставляется свой домен с reverse proxy, потому
   * что адреса облака доступны не из всех сетей.
   */
  S3_PUBLIC_BASE: z.string().default(''),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  /** Бакет один на бот и CRM: у облачного тарифа их больше одного не бывает. */
  S3_BUCKET: z.string().min(3).default('cpi-artifacts'),
  /** Верхняя папка владельца внутри общего бакета. */
  S3_PREFIX: storagePrefix,
  S3_FORCE_PATH_STYLE: boolean(true),
});

export const apiEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironment,
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: integer(3001, 1),
    REDIS_PREFIX: z.string().trim().min(1).max(100).default('cpi-artifacts'),
    WEB_ORIGIN: z.url(),
    TELEGRAM_BOT_TOKEN: z.string().min(8),
    TELEGRAM_AUTH_MAX_AGE_SECONDS: integer(86_400, 60),
    MAX_BOT_TOKEN: optionalSecret(8),
    MAX_AUTH_MAX_AGE_SECONDS: integer(3_600, 60),
    LEADER_ID_ENABLED: boolean(false),
    // The published Apps v1 OAuth authorization endpoint is production-only. Keep the mixed,
    // currently non-resolving staging host disabled until Leader-ID documents a complete pair.
    LEADER_ID_ENVIRONMENT: z.literal('production').default('production'),
    LEADER_ID_CLIENT_ID: optionalSecret(1),
    LEADER_ID_CLIENT_SECRET: optionalSecret(8),
    LEADER_ID_SERVER_CLIENT_ID: optionalSecret(1),
    LEADER_ID_SERVER_CLIENT_SECRET: optionalSecret(8),
    LEADER_ID_TOKEN_ACTIVE_KEY_ID: optionalSecret(1),
    /** JSON object: {"key-id":"32-byte-canonical-base64url-key"}. */
    LEADER_ID_TOKEN_KEYRING: optionalSecret(2),
    LEADER_ID_OAUTH_SCOPE: optionalSecret(1),
    LEADER_ID_OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(1_800).default(600),
    LEADER_ID_API_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(10_000),
    SESSION_TTL_SECONDS: integer(604_800, 300),
    SESSION_COOKIE_NAME: z.string().min(1).default('cpi_artifacts_session'),
    COOKIE_DOMAIN: z.string().optional(),
    DEV_AUTH_ENABLED: boolean(false),
    SUPERADMIN_TELEGRAM_IDS: commaSeparated,
    SUPERADMIN_MAX_IDS: commaSeparated,
    PRESIGNED_URL_TTL_SECONDS: integer(900, 60),
    MULTIPART_THRESHOLD_BYTES: integer(20 * 1024 ** 2, 5 * 1024 ** 2),
    MULTIPART_PART_SIZE_BYTES: integer(10 * 1024 ** 2, 5 * 1024 ** 2),
    GLOBAL_MAX_FILE_SIZE_BYTES: integer(2 * 1024 ** 3, 1),
    CRM_API_URL: z.url(),
    CRM_INTEGRATION_TOKEN: z.string().min(32),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .and(databaseSchema)
  .and(redisSchema)
  .and(s3Schema)
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && environment.S3_PREFIX !== 'locker/') {
      context.addIssue({
        code: 'custom',
        path: ['S3_PREFIX'],
        message: 'В production S3_PREFIX должен быть locker/',
      });
    }
    if (!environment.LEADER_ID_ENABLED) return;

    const requiredLeaderIdSecrets = [
      ['LEADER_ID_CLIENT_ID', environment.LEADER_ID_CLIENT_ID],
      ['LEADER_ID_CLIENT_SECRET', environment.LEADER_ID_CLIENT_SECRET],
      ['LEADER_ID_SERVER_CLIENT_ID', environment.LEADER_ID_SERVER_CLIENT_ID],
      ['LEADER_ID_SERVER_CLIENT_SECRET', environment.LEADER_ID_SERVER_CLIENT_SECRET],
      ['LEADER_ID_TOKEN_ACTIVE_KEY_ID', environment.LEADER_ID_TOKEN_ACTIVE_KEY_ID],
      ['LEADER_ID_TOKEN_KEYRING', environment.LEADER_ID_TOKEN_KEYRING],
    ] as const;
    for (const [path, value] of requiredLeaderIdSecrets) {
      if (!value) {
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `${path} обязателен при LEADER_ID_ENABLED=true`,
        });
      }
    }
    if (
      environment.LEADER_ID_TOKEN_ACTIVE_KEY_ID &&
      !/^[A-Za-z0-9_-]{1,32}$/u.test(environment.LEADER_ID_TOKEN_ACTIVE_KEY_ID)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['LEADER_ID_TOKEN_ACTIVE_KEY_ID'],
        message: 'LEADER_ID_TOKEN_ACTIVE_KEY_ID содержит недопустимые символы',
      });
    }
    if (environment.LEADER_ID_TOKEN_KEYRING) {
      try {
        const parsed: unknown = JSON.parse(environment.LEADER_ID_TOKEN_KEYRING);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length === 0
        ) {
          throw new Error('empty key ring');
        }
        for (const [keyId, key] of Object.entries(parsed)) {
          if (!/^[A-Za-z0-9_-]{1,32}$/u.test(keyId) || typeof key !== 'string') {
            throw new Error('invalid key entry');
          }
          const decoded = Buffer.from(key, 'base64url');
          if (decoded.length !== 32 || decoded.toString('base64url') !== key) {
            throw new Error('invalid key length');
          }
        }
        if (
          environment.LEADER_ID_TOKEN_ACTIVE_KEY_ID &&
          !(environment.LEADER_ID_TOKEN_ACTIVE_KEY_ID in parsed)
        ) {
          throw new Error('active key missing');
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['LEADER_ID_TOKEN_KEYRING'],
          message:
            'LEADER_ID_TOKEN_KEYRING должен содержать валидное JSON-кольцо 256-битных ключей',
        });
      }
    }
    if (
      environment.NODE_ENV === 'production' &&
      new URL(environment.WEB_ORIGIN).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'Leader-ID OAuth в production требует HTTPS WEB_ORIGIN',
      });
    }
  });

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

export const workerEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironment,
    REDIS_PREFIX: z.string().default('cpi-artifacts'),
    WORKER_HEALTH_HOST: z.string().default('0.0.0.0'),
    WORKER_HEALTH_PORT: integer(3003, 1),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    WEB_ORIGIN: z.url(),
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: integer(3310, 1),
    FILE_VERIFICATION_MODE: z.enum(['clamav', 'metadata-only']).default('metadata-only'),
    EXPORT_LINK_TTL_SECONDS: integer(86_400, 300),
    EXPORT_RETENTION_HOURS: integer(1, 1),
    ABANDONED_UPLOAD_HOURS: integer(1, 1),
    DELETED_OBJECT_RETENTION_DAYS: integer(0),
    WORKER_CONCURRENCY: integer(2, 1),
    CRM_API_URL: z.url(),
    CRM_INTEGRATION_TOKEN: z.string().min(32),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .and(databaseSchema)
  .and(redisSchema)
  .and(s3Schema)
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && environment.S3_PREFIX !== 'locker/') {
      context.addIssue({
        code: 'custom',
        path: ['S3_PREFIX'],
        message: 'В production S3_PREFIX должен быть locker/',
      });
    }
    if (environment.FILE_VERIFICATION_MODE === 'clamav' && !environment.CLAMAV_HOST?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['CLAMAV_HOST'],
        message: 'CLAMAV_HOST обязателен при FILE_VERIFICATION_MODE=clamav',
      });
    }
  });

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export const botEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironment,
  BOT_HOST: z.string().default('0.0.0.0'),
  BOT_PORT: integer(3002, 1),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  SUPERADMIN_TELEGRAM_IDS: commaSeparated,
  TELEGRAM_CATALYST_CHAT_INVITE_URL: optionalTelegramInviteUrl,
  TELEGRAM_CATALYST_CHAT_ID: optionalTelegramChatId,
  MAX_BOT_TOKEN: optionalSecret(8),
  MAX_BOT_USERNAME: optionalSecret(1),
  MAX_API_BASE: z.url().default('https://platform-api2.max.ru'),
  MAX_WEBHOOK_SECRET: optionalSecret(16),
  MAX_WEBHOOK_PATH: z.string().startsWith('/').default('/max/webhook'),
  WEB_APP_URL: z.url(),
  BOT_WEBHOOK_SECRET: z.string().min(16).optional(),
  BOT_WEBHOOK_PATH: z.string().startsWith('/').default('/telegram/webhook'),
  BOT_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  REDIS_PREFIX: z.string().default('cpi-artifacts'),
  // Отклики на рассылки CRM приходят в чат бота, поэтому пересылать их обратно
  // может только он. Без адреса CRM кнопки просто не подключаются.
  CRM_API_URL: z.url().optional(),
  CRM_INTEGRATION_TOKEN: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type BotEnvironment = z.infer<typeof botEnvironmentSchema>;

export function parseEnvironment<T>(schema: z.ZodType<T>, environment: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const message = z.prettifyError(result.error);
    throw new Error(`Некорректная конфигурация окружения:\n${message}`);
  }
  return result.data;
}
