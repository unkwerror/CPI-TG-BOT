import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { outboxEvents } from '@cpi/db';
import type { WorkerContext } from './context';

export async function dispatchOutbox(
  context: WorkerContext,
  queues: {
    artifacts: Queue;
    exports: Queue;
    notifications: Queue;
    crm: Queue;
  },
): Promise<number> {
  const rows = await context.db
    .select()
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.processedAt), lte(outboxEvents.availableAt, new Date())))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(100);
  let processed = 0;
  for (const row of rows) {
    try {
      if (row.type === 'artifact.uploaded') {
        await queues.artifacts.add(
          'verify-artifact',
          { artifactId: row.aggregateId },
          {
            jobId: row.aggregateId,
            attempts: 5,
            backoff: { type: 'exponential', delay: 2_000 },
            removeOnComplete: 500,
            removeOnFail: 1_000,
          },
        );
      } else if (row.type === 'export.requested') {
        await queues.exports.add(
          'build-export',
          { exportJobId: row.aggregateId },
          {
            jobId: row.aggregateId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 200,
            removeOnFail: 500,
          },
        );
      } else if (row.type === 'submission.ready' || row.type === 'artifact.failed') {
        await queues.notifications.add(
          'send-notification',
          { type: row.type, ...row.payload },
          {
            jobId: row.id,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1_000,
            removeOnFail: 1_000,
          },
        );
      } else if (row.type === 'crm.submission.sync') {
        await queues.crm.add(
          'sync-submission-to-crm',
          { submissionId: row.aggregateId },
          {
            jobId: row.id,
            attempts: 10,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1_000,
            removeOnFail: 2_000,
          },
        );
      }
      await context.db
        .update(outboxEvents)
        .set({ processedAt: new Date(), lastError: null })
        .where(and(eq(outboxEvents.id, row.id), isNull(outboxEvents.processedAt)));
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delaySeconds = Math.min(300, 2 ** Math.min(row.attempts, 8));
      await context.db
        .update(outboxEvents)
        .set({
          attempts: sql`${outboxEvents.attempts} + 1`,
          lastError: message.slice(0, 2_000),
          availableAt: new Date(Date.now() + delaySeconds * 1_000),
        })
        .where(eq(outboxEvents.id, row.id));
      context.logger.warn({ error, outboxId: row.id }, 'Outbox dispatch failed');
    }
  }
  return processed;
}
