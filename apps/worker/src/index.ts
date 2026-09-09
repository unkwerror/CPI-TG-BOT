import { createServer } from 'node:http';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import pino from 'pino';
import { parseEnvironment, workerEnvironmentSchema } from '@cpi/config';
import { assertStorageCutoverInvariant, createDatabase } from '@cpi/db';
import type { WorkerContext } from './context';
import { buildExport } from './exporter';
import {
  syncAllActiveUsersToCrm,
  syncAllLockerEventsToCrm,
  syncAllParticipationsToCrm,
  syncReadySubmissionsToCrm,
  pullCrmEventsIntoLocker,
  syncEventToCrm,
  syncParticipationToCrm,
  syncSubmissionToCrm,
  syncUserToCrm,
} from './crm-sync';
import { runMaintenance } from './maintenance';
import { dispatchOutbox } from './outbox';
import { verifyArtifact } from './verifier';
import { assertClamavReady } from './clamav';
import { configuredClamavScanner } from './verification-policy';
import { reconcileContentBroadcastSchedules } from './content-broadcasts';

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
const context: WorkerContext = { config, db, s3, logger, redis: connection };
const queueOptions = { connection, prefix: config.REDIS_PREFIX };
const artifactQueue = new Queue('artifact-verification', queueOptions);
const exportQueue = new Queue('exports', queueOptions);
const notificationQueue = new Queue('notifications', queueOptions);
const crmQueue = new Queue('crm-sync', queueOptions);

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

const crmWorker = new Worker(
  'crm-sync',
  async (job) => {
    const data = job.data as {
      submissionId?: string;
      userId?: string;
      eventId?: string;
    };
    if (job.name === 'sync-user-to-crm' && data.userId) {
      await syncUserToCrm(context, String(data.userId));
      return;
    }
    if (job.name === 'sync-event-to-crm' && data.eventId) {
      await syncEventToCrm(context, String(data.eventId));
      return;
    }
    if (job.name === 'sync-participation-to-crm' && data.eventId && data.userId) {
      await syncParticipationToCrm(context, String(data.eventId), String(data.userId));
      return;
    }
    const submissionId = String(data.submissionId ?? '');
    if (!submissionId) throw new Error('submissionId, userId or eventId is required');
    await syncSubmissionToCrm(context, submissionId);
  },
  {
    ...queueOptions,
    concurrency: 2,
    lockDuration: 2 * 60 * 1_000,
    limiter: { max: 240, duration: 60_000 },
  },
);

for (const worker of [artifactWorker, exportWorker, crmWorker]) {
  worker.on('completed', (job) =>
    logger.info({ queue: worker.name, jobId: job.id }, 'Job completed'),
  );
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
      crm: crmQueue,
    });
  } catch (error) {
    logger.error({ error }, 'Outbox polling failed');
  }
};

const maintain = async () => {
  if (stopping) return;
  const lock = await connection.set(
    `${config.REDIS_PREFIX}:maintenance-lock-v2`,
    process.pid.toString(),
    'EX',
    240,
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

const pullCrmEvents = async () => {
  if (stopping) return;
  const lock = await connection.set(
    `${config.REDIS_PREFIX}:crm-event-catalog-lock`,
    process.pid.toString(),
    'EX',
    55,
    'NX',
  );
  if (!lock) return;
  try {
    const result = await pullCrmEventsIntoLocker(context);
    logger.info(result, 'CRM event catalog synchronized with Locker');
  } catch (error) {
    logger.error({ error }, 'CRM event catalog synchronization failed');
  }
};

const reconcileCrmSubmissions = async () => {
  if (stopping) return;
  const lock = await connection.set(
    `${config.REDIS_PREFIX}:crm-submission-reconciliation-lock`,
    process.pid.toString(),
    'EX',
    240,
    'NX',
  );
  if (!lock) return;
  try {
    const result = await syncReadySubmissionsToCrm(context);
    if (result.total > 0) {
      logger.info(result, 'CRM submission reconciliation completed');
    }
  } catch (error) {
    logger.error({ error }, 'CRM submission reconciliation failed');
  }
};

const reconcileContentBroadcasts = async () => {
  if (stopping) return;
  const lock = await connection.set(
    `${config.REDIS_PREFIX}:content-broadcast-schedule-lock`,
    process.pid.toString(),
    'EX',
    240,
    'NX',
  );
  if (!lock) return;
  try {
    const result = await reconcileContentBroadcastSchedules(context);
    if (result.eventUploads + result.feedPosts + result.products > 0) {
      logger.info(result, 'Future content broadcasts scheduled');
    }
  } catch (error) {
    logger.error({ error }, 'Content broadcast scheduling failed');
  }
};

const outboxTimer = setInterval(() => void dispatch(), 5_000);
const maintenanceTimer = setInterval(() => void maintain(), 5 * 60 * 1_000);
const crmEventCatalogTimer = setInterval(() => void pullCrmEvents(), 60 * 1_000);
const crmSubmissionReconciliationTimer = setInterval(
  () => void reconcileCrmSubmissions(),
  5 * 60 * 1_000,
);
const contentBroadcastTimer = setInterval(() => void reconcileContentBroadcasts(), 5 * 60 * 1_000);
outboxTimer.unref();
maintenanceTimer.unref();
crmEventCatalogTimer.unref();
crmSubmissionReconciliationTimer.unref();
contentBroadcastTimer.unref();
void dispatch();
void maintain();
void reconcileContentBroadcasts();
void (async () => {
  const usersResult = await syncAllActiveUsersToCrm(context);
  logger.info(usersResult, 'CRM user backfill completed');
  const eventsResult = await syncAllLockerEventsToCrm(context);
  logger.info(eventsResult, 'CRM event backfill completed');
  const participationsResult = await syncAllParticipationsToCrm(context);
  logger.info(participationsResult, 'CRM participation backfill completed');
  await reconcileCrmSubmissions();
  await pullCrmEvents();
})().catch((error) => logger.error({ error }, 'CRM startup reconciliation failed'));

const healthServer = createServer(async (request, response) => {
  if (request.url === '/health/live') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'worker' }));
    return;
  }
  if (request.url === '/health/ready') {
    try {
      await Promise.all([
        db.execute(sql`select "active_season_id" from "point_programs" limit 1`),
        connection.ping(),
        s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })),
        assertStorageCutoverInvariant(db, config.S3_BUCKET, config.S3_PREFIX),
      ]);
      const scanner = configuredClamavScanner(config);
      if (scanner) await assertClamavReady(scanner);
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
  clearInterval(crmEventCatalogTimer);
  clearInterval(crmSubmissionReconciliationTimer);
  clearInterval(contentBroadcastTimer);
  await Promise.allSettled([
    artifactWorker.close(),
    exportWorker.close(),
    crmWorker.close(),
    artifactQueue.close(),
    exportQueue.close(),
    notificationQueue.close(),
    crmQueue.close(),
    new Promise<void>((resolve) => healthServer.close(() => resolve())),
  ]);
  s3.destroy();
  await Promise.allSettled([connection.quit(), pool.end()]);
  process.exit(0);
};

process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));
