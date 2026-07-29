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

const nodeEnvironment = z.enum(['development', 'test', 'production']).default('development');

const databaseSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

const redisSchema = z.object({
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
});

const s3Schema = z.object({
  S3_INTERNAL_ENDPOINT: z.url().default('http://localhost:9000'),
  S3_PUBLIC_ENDPOINT: z.url().default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  S3_QUARANTINE_BUCKET: z.string().min(3).default('artifacts-quarantine'),
  S3_PRIVATE_BUCKET: z.string().min(3).default('artifacts-private'),
  S3_EXPORT_BUCKET: z.string().min(3).default('artifacts-exports'),
  S3_FORCE_PATH_STYLE: boolean(true),
});

export const apiEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironment,
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: integer(3001, 1),
    WEB_ORIGIN: z.url(),
    TELEGRAM_BOT_TOKEN: z.string().min(8),
    TELEGRAM_AUTH_MAX_AGE_SECONDS: integer(86_400, 60),
    SESSION_TTL_SECONDS: integer(604_800, 300),
    SESSION_COOKIE_NAME: z.string().min(1).default('cpi_artifacts_session'),
    COOKIE_DOMAIN: z.string().optional(),
    DEV_AUTH_ENABLED: boolean(false),
    SUPERADMIN_TELEGRAM_IDS: commaSeparated,
    PRESIGNED_URL_TTL_SECONDS: integer(900, 60),
    MULTIPART_THRESHOLD_BYTES: integer(20 * 1024 ** 2, 5 * 1024 ** 2),
    MULTIPART_PART_SIZE_BYTES: integer(10 * 1024 ** 2, 5 * 1024 ** 2),
    GLOBAL_MAX_FILE_SIZE_BYTES: integer(2 * 1024 ** 3, 1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .and(databaseSchema)
  .and(redisSchema)
  .and(s3Schema);

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
    EXPORT_RETENTION_HOURS: integer(48, 1),
    ABANDONED_UPLOAD_HOURS: integer(24, 1),
    DELETED_OBJECT_RETENTION_DAYS: integer(30, 1),
    WORKER_CONCURRENCY: integer(2, 1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .and(databaseSchema)
  .and(redisSchema)
  .and(s3Schema);

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export const botEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironment,
  BOT_HOST: z.string().default('0.0.0.0'),
  BOT_PORT: integer(3002, 1),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  WEB_APP_URL: z.url(),
  BOT_WEBHOOK_SECRET: z.string().min(16).optional(),
  BOT_WEBHOOK_PATH: z.string().startsWith('/').default('/telegram/webhook'),
  BOT_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  REDIS_PREFIX: z.string().default('cpi-artifacts'),
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
