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
import { createDatabase } from '@cpi/db';
import { AppError, type ApiErrorBody } from '@cpi/shared';
import { authPlugin } from './auth';
import { adminExportRoutes } from './routes/admin-exports';
import { adminRoleRoutes } from './routes/admin-roles';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { crmIntegrationRoutes } from './routes/crm-integration';
import { eventRoutes } from './routes/events';
import { meRoutes } from './routes/me';
import { uploadRoutes } from './routes/uploads';
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

  const commonS3 = {
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
  const s3Internal = new S3Client({ ...commonS3, endpoint: config.S3_INTERNAL_ENDPOINT });
  const s3Public = new S3Client({ ...commonS3, endpoint: config.S3_PUBLIC_ENDPOINT });
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
  app.decorate('s3Internal', s3Internal);
  app.decorate('s3Public', s3Public);
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
        description: 'API Telegram Mini App для сбора артефактов мероприятий',
      },
      servers: [{ url: config.WEB_ORIGIN }],
      tags: [
        { name: 'auth', description: 'Telegram-авторизация' },
        { name: 'events', description: 'Мероприятия' },
        { name: 'submissions', description: 'Отправки' },
        { name: 'uploads', description: 'Прямая S3-загрузка' },
        { name: 'admin', description: 'Администрирование' },
        { name: 'integrations', description: 'Серверная интеграция с CRM' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await app.register(authPlugin);
  await app.register(
    async (versioned) => {
      await versioned.register(authRoutes);
      await versioned.register(crmIntegrationRoutes);
      await versioned.register(meRoutes);
      await versioned.register(eventRoutes);
      await versioned.register(uploadRoutes);
      await versioned.register(adminRoutes);
      await versioned.register(adminExportRoutes);
      await versioned.register(adminRoleRoutes);
    },
    { prefix: '/api/v1' },
  );

  app.get('/health/live', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    service: 'api',
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', { logLevel: 'silent' }, async (_request, reply) => {
    try {
      await Promise.all([
        db.execute(sql`select 1`),
        redis.ping(),
        s3Internal.send(new HeadBucketCommand({ Bucket: config.S3_PRIVATE_BUCKET })),
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

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Маршрут не найден',
        requestId: request.id,
      },
    } satisfies ApiErrorBody),
  );

  app.setErrorHandler((error, request, reply) => {
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
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: 'Запись с такими уникальными данными уже существует',
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

  app.addHook('onClose', async () => {
    s3Internal.destroy();
    s3Public.destroy();
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
