import { createServer } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import pino from 'pino';
import { parseEnvironment, workerEnvironmentSchema } from '@cpi/config';
import { createDatabase } from '@cpi/db';
import type { WorkerContext } from './context';
import { buildExport } from './exporter';
import { runMaintenance } from './maintenance';
import { dispatchOutbox } from './outbox';
import { verifyArtifact } from './verifier';

const config = parseEnvironment(workerEnvironmentSchema, process.env);
const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ['*.token', '*.url', '*.initData', '*.authorization'],
    censor: '[REDACTED]',
  },
});
const { db, pool } = createDatabase(config.DATABASE_URL, { max: 6 });
const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
const s3 = new S3Client({
  endpoint: config.S3_INTERNAL_ENDPOINT,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const context: WorkerContext = { config, db, s3, logger };
const queueOptions = { connection, prefix: config.REDIS_PREFIX };
const artifactQueue = new Queue('artifact-verification', queueOptions);
const exportQueue = new Queue('exports', queueOptions);
const notificationQueue = new Queue('notifications', queueOptions);

const artifactWorker = new Worker(
  'artifact-verification',
  async (job) => {
    const artifactId = String((job.data as { artifactId?: string }).artifactId ?? '');
    if (!artifactId) throw new Error('artifactId is required');
    await verifyArtifact(context, artifactId);
  },
  {
    ...queueOptions,
    concurrency: config.WORKER_CONCURRENCY,
    lockDuration: 10 * 60 * 1_000,
  },
);

const exportWorker = new Worker(
  'exports',
  async (job) => {
    const exportJobId = String((job.data as { exportJobId?: string }).exportJobId ?? '');
    if (!exportJobId) throw new Error('exportJobId is required');
    await buildExport(context, exportJobId);
  },
  {
    ...queueOptions,
    concurrency: 1,
    lockDuration: 30 * 60 * 1_000,
  },
);

for (const worker of [artifactWorker, exportWorker]) {
  worker.on('completed', (job) => logger.info({ queue: worker.name, jobId: job.id }, 'Job completed'));
  worker.on('failed', (job, error) =>
    logger.error({ queue: worker.name, jobId: job?.id, error }, 'Job failed'),
  );
  worker.on('error', (error) => logger.error({ queue: worker.name, error }, 'Worker error'));
}

let stopping = false;
const dispatch = async () => {
  if (stopping) return;
  const lock = await connection.set(
    `${config.REDIS_PREFIX}:outbox-lock`,
    process.pid.toString(),
    'EX',
    4,
    'NX',
  );
  if (!lock) return;
  try {
    await dispatchOutbox(context, {
      artifacts: artifactQueue,
      exports: exportQueue,
      notifications: notificationQueue,
    });
  } catch (error) {
    logger.error({ error }, 'Outbox polling failed');
  }
};

const maintain = async () => {
  if (stopping) return;
  const lock = await connection.set(
    `${config.REDIS_PREFIX}:maintenance-lock`,
    process.pid.toString(),
    'EX',
    3_500,
    'NX',
  );
  if (!lock) return;
  try {
    const result = await runMaintenance(context);
    logger.info(result, 'Maintenance completed');
  } catch (error) {
    logger.error({ error }, 'Maintenance failed');
  }
};

const outboxTimer = setInterval(() => void dispatch(), 5_000);
const maintenanceTimer = setInterval(() => void maintain(), 60 * 60 * 1_000);
outboxTimer.unref();
maintenanceTimer.unref();
void dispatch();
void maintain();

const healthServer = createServer(async (request, response) => {
  if (request.url === '/health/live') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'worker' }));
    return;
  }
  if (request.url === '/health/ready') {
    try {
      await Promise.all([db.execute(sql`select 1`), connection.ping()]);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ready', service: 'worker' }));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'not_ready', service: 'worker' }));
    }
    return;
  }
  response.writeHead(404).end();
});
healthServer.listen(config.WORKER_HEALTH_PORT, config.WORKER_HEALTH_HOST, () => {
  logger.info(
    { host: config.WORKER_HEALTH_HOST, port: config.WORKER_HEALTH_PORT },
    'Worker health server listening',
  );
});

const close = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Stopping worker');
  clearInterval(outboxTimer);
  clearInterval(maintenanceTimer);
  await Promise.allSettled([
    artifactWorker.close(),
    exportWorker.close(),
    artifactQueue.close(),
    exportQueue.close(),
    notificationQueue.close(),
    new Promise<void>((resolve) => healthServer.close(() => resolve())),
  ]);
  s3.destroy();
  await Promise.allSettled([connection.quit(), pool.end()]);
  process.exit(0);
};

process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));
