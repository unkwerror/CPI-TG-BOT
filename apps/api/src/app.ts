import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { ZodError } from 'zod';
import type { ApiEnvironment } from '@cpi/config';
import { assertStorageCutoverInvariant, createDatabase } from '@cpi/db';
import { AppError, type ApiErrorBody } from '@cpi/shared';
import { authPlugin } from './auth';
import { adminExportRoutes } from './routes/admin-exports';
import { adminBroadcastRoutes } from './routes/admin-broadcasts';
import { adminRoleRoutes } from './routes/admin-roles';
import { adminWalletRoutes } from './routes/admin-wallet';
import { adminContentRoutes } from './routes/admin-content';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { coworkingRoutes } from './routes/coworking';
import { crmIntegrationRoutes } from './routes/crm-integration';
import { eventRoutes } from './routes/events';
import { quickAnswerRoutes } from './routes/quick-answers';
import { eventRequestRoutes } from './routes/event-requests';
import {
  createLeaderIdProduction,
  enqueueLeaderIdTelegramChatInvite,
  reconcileLeaderIdSubscriptions,
} from './leader-id-production';
import { meRoutes } from './routes/me';
import { projectRoutes } from './routes/projects';
import { uploadRoutes } from './routes/uploads';
import { walletRoutes } from './routes/wallet';
import './types';

export async function buildApp(config: ApiEnvironment) {
  const app = Fastify({
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-csrf-token',
          'res.headers.set-cookie',
          '*.initData',
          '*.uploadUrl',
          '*.url',
          '*.token',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 1_048_576,
  });

  const { db, pool } = createDatabase(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  const queueRedis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  await Promise.all([redis.connect(), queueRedis.connect()]);

  const leaderId = config.LEADER_ID_ENABLED
    ? (() => {
        if (
          !config.LEADER_ID_CLIENT_ID ||
          !config.LEADER_ID_CLIENT_SECRET ||
          !config.LEADER_ID_SERVER_CLIENT_ID ||
          !config.LEADER_ID_SERVER_CLIENT_SECRET ||
          !config.LEADER_ID_TOKEN_ACTIVE_KEY_ID ||
          !config.LEADER_ID_TOKEN_KEYRING
        ) {
          throw new Error('Leader-ID is enabled without complete backend credentials');
        }
        const tokenKeys = JSON.parse(config.LEADER_ID_TOKEN_KEYRING) as Record<string, string>;
        const webOrigin = new URL(config.WEB_ORIGIN);
        const callbackUrl = new URL('/api/v1/catalyst/leader-id/oauth/callback', webOrigin);
        const completionUrl = new URL('/leader-id/complete', webOrigin);
        return createLeaderIdProduction({
          database: db,
          redis,
          config: {
            oauthClientId: config.LEADER_ID_CLIENT_ID,
            oauthClientSecret: config.LEADER_ID_CLIENT_SECRET,
            serverClientId: config.LEADER_ID_SERVER_CLIENT_ID,
            serverClientSecret: config.LEADER_ID_SERVER_CLIENT_SECRET,
            oauthRedirectUri: callbackUrl.toString(),
            successRedirectUrl: completionUrl.toString(),
            failureRedirectUrl: completionUrl.toString(),
            tokenKeyRing: {
              activeKeyId: config.LEADER_ID_TOKEN_ACTIVE_KEY_ID,
              keys: tokenKeys,
            },
            redisPrefix: config.REDIS_PREFIX,
            environment: config.LEADER_ID_ENVIRONMENT,
            apiTimeoutMs: config.LEADER_ID_API_TIMEOUT_MS,
            oauthStateTtlSeconds: config.LEADER_ID_OAUTH_STATE_TTL_SECONDS,
            ...(config.LEADER_ID_OAUTH_SCOPE === undefined
              ? {}
              : { oauthScope: config.LEADER_ID_OAUTH_SCOPE }),
          },
        });
      })()
    : null;

  let leaderIdReconciliation: Promise<void> | null = null;

  // Ссылки для браузера подписываются на хост хранилища и лишь потом
  // переписываются на свой домен, поэтому клиент нужен один.
  const s3 = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const artifactQueue = new Queue('artifact-verification', {
    connection: queueRedis,
    prefix: 'cpi-artifacts',
  });
  const exportQueue = new Queue('exports', {
    connection: queueRedis,
    prefix: 'cpi-artifacts',
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('s3', s3);
  app.decorate('artifactQueue', artifactQueue);
  app.decorate('exportQueue', exportQueue);

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || origin === config.WEB_ORIGIN) callback(null, true);
      else callback(new Error('Origin is not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'idempotency-key'],
    maxAge: 86_400,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (request) => request.currentUser?.id ?? request.ip,
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'CPI Artifacts API',
        version: '1.0.0',
        description: 'API Mini App для Telegram и MAX',
      },
      servers: [{ url: config.WEB_ORIGIN }],
      tags: [
        { name: 'auth', description: 'Авторизация Telegram и MAX' },
        { name: 'events', description: 'Мероприятия' },
        { name: 'submissions', description: 'Отправки' },
        { name: 'uploads', description: 'Прямая S3-загрузка' },
        { name: 'wallet', description: 'Баллы, QR и переводы' },
        { name: 'store', description: 'Магазин наград' },
        { name: 'feed', description: 'Лента обновлений' },
        { name: 'leader-id', description: 'Подключение Leader-ID и события Catalyst' },
        { name: 'projects', description: 'Проекты, команды и заявки участников' },
        { name: 'admin', description: 'Администрирование' },
        { name: 'integrations', description: 'Серверная интеграция с CRM' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  const sendApiError = (instance: {
    setNotFoundHandler: typeof app.setNotFoundHandler;
    setErrorHandler: typeof app.setErrorHandler;
  }) => {
    instance.setNotFoundHandler((request, reply) =>
      reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Маршрут не найден',
          requestId: request.id,
        },
      } satisfies ApiErrorBody),
    );
    instance.setErrorHandler((error, request, reply) => {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Проверьте заполненные поля',
            requestId: request.id,
            details: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        } satisfies ApiErrorBody);
      }
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        } satisfies ApiErrorBody);
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        return reply.code(409).send({
          error: {
            code: 'CONFLICT',
            message: 'Запись с такими уникальными данными уже существует',
            requestId: request.id,
          },
        } satisfies ApiErrorBody);
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '40P01'
      ) {
        return reply.code(409).send({
          error: {
            code: 'TRANSACTION_RETRY_REQUIRED',
            message: 'Операция столкнулась с параллельным изменением. Повторите её.',
            requestId: request.id,
          },
        } satisfies ApiErrorBody);
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
        typeof (error as { message?: unknown }).message === 'string'
      ) {
        const httpError = error as { statusCode: number; code?: string; message: string };
        return reply.code(httpError.statusCode).send({
          error: {
            code: httpError.code ?? 'REQUEST_FAILED',
            message: httpError.message,
            requestId: request.id,
          },
        } satisfies ApiErrorBody);
      }
      request.log.error({ error }, 'Unhandled request error');
      return reply.code(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Внутренняя ошибка сервиса',
          requestId: request.id,
        },
      } satisfies ApiErrorBody);
    });
  };

  sendApiError(app);
  await app.register(authPlugin);
  await app.register(
    async (versioned) => {
      sendApiError(versioned);
      await versioned.register(authRoutes);
      await versioned.register(coworkingRoutes);
      await versioned.register(crmIntegrationRoutes);
      await versioned.register(meRoutes);
      await versioned.register(projectRoutes);
      await versioned.register(eventRoutes);
      await versioned.register(quickAnswerRoutes);
      await versioned.register(eventRequestRoutes);
      if (leaderId) await versioned.register(leaderId.routes);
      await versioned.register(uploadRoutes);
      await versioned.register(walletRoutes);
      await versioned.register(adminRoutes);
      await versioned.register(adminBroadcastRoutes);
      await versioned.register(adminExportRoutes);
      await versioned.register(adminRoleRoutes);
      await versioned.register(adminWalletRoutes);
      await versioned.register(adminContentRoutes);
    },
    { prefix: '/api/v1' },
  );

  if (leaderId) {
    app.addHook('onReady', () => {
      leaderIdReconciliation = reconcileLeaderIdSubscriptions({
        bindings: leaderId.adapters.bindings,
        service: leaderId.service,
        onSuccess: (catalystUserId) => enqueueLeaderIdTelegramChatInvite(db, catalystUserId),
        onFailure: (error) => {
          app.log.warn(
            {
              errorCode:
                error instanceof AppError ? error.code : 'LEADER_ID_RECONCILIATION_USER_FAILED',
            },
            'Leader-ID startup reconciliation failed for one binding',
          );
        },
      })
        .then((summary) => {
          app.log.info(
            {
              totalBindings: summary.totalBindings,
              succeeded: summary.succeeded,
              failed: summary.failed,
            },
            'Leader-ID startup reconciliation completed',
          );
        })
        .catch((error: unknown) => {
          app.log.error(
            {
              errorCode: error instanceof AppError ? error.code : 'LEADER_ID_RECONCILIATION_FAILED',
            },
            'Leader-ID startup reconciliation could not start',
          );
        });
    });
  }

  app.get('/health/live', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    service: 'api',
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', { logLevel: 'silent' }, async (_request, reply) => {
    try {
      await Promise.all([
        // Readiness must fail when a new image starts against an older schema;
        // a generic `select 1` allowed the API to report healthy while every
        // submission query failed after a skipped migration.
        db.execute(sql`select "crm_pending_review_at" from "submissions" limit 0`),
        db.execute(sql`
          select "active_season_id", "leader_id_subscription_reward" from "point_programs" limit 1
        `),
        db.execute(sql`
          select "accepts_requests", "active_form_version_id", "leader_id_event_id"
          from "events" limit 0
        `),
        db.execute(sql`select "status" from "leader_id_event_registrations" limit 0`),
        db.execute(sql`select "status" from "event_requests" limit 0`),
        redis.ping(),
        s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })),
        assertStorageCutoverInvariant(db, config.S3_BUCKET, config.S3_PREFIX),
      ]);
      return { status: 'ready', service: 'api', timestamp: new Date().toISOString() };
    } catch {
      return reply
        .code(503)
        .send({ status: 'not_ready', service: 'api', timestamp: new Date().toISOString() });
    }
  });

  app.get('/metrics', { logLevel: 'silent' }, async (_request, reply) => {
    const [artifactResult] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from((await import('@cpi/db')).artifacts);
    return reply
      .type('text/plain; version=0.0.4')
      .send(
        [
          '# HELP cpi_artifacts_total Total artifact metadata rows',
          '# TYPE cpi_artifacts_total gauge',
          `cpi_artifacts_total ${artifactResult?.value ?? 0}`,
          '# HELP cpi_api_up API process availability',
          '# TYPE cpi_api_up gauge',
          'cpi_api_up 1',
          '',
        ].join('\n'),
      );
  });

  app.addHook('onClose', async () => {
    s3.destroy();
    if (leaderIdReconciliation) await leaderIdReconciliation;
    await Promise.allSettled([
      artifactQueue.close(),
      exportQueue.close(),
      redis.quit(),
      queueRedis.quit(),
      pool.end(),
    ]);
  });

  return app;
}
