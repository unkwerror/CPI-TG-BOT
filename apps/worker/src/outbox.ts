import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import { outboxEvents } from '@cpi/db';
import { grantArtifactReward } from '../../api/src/wallet-service';
import type { WorkerContext } from './context';

export const notificationOutboxTypes = new Set([
  'submission.ready',
  'artifact.failed',
  'wallet.transaction.posted',
  'wallet.intent.created',
  'store.order.paid',
  'store.order.pickup_requested',
  'store.order.ready_for_pickup',
  'store.order.fulfilled',
  'reward.artifact.granted',
  'broadcast.event.published',
  'broadcast.event.uploads_opened',
  'broadcast.feed.published',
  'broadcast.product.published',
  'leader_id.telegram_chat_invite',
]);

export function artifactSourceCleanupTarget(payload: Record<string, unknown>): {
  bucket: string;
  objectKey: string;
} {
  const bucket = typeof payload.bucket === 'string' ? payload.bucket.trim() : '';
  const objectKey = typeof payload.objectKey === 'string' ? payload.objectKey : '';
  if (!bucket || !objectKey) throw new Error('Invalid artifact.source.cleanup payload');
  return { bucket, objectKey };
}

export async function deleteArtifactSourceObject(
  s3: WorkerContext['s3'],
  payload: Record<string, unknown>,
): Promise<void> {
  const source = artifactSourceCleanupTarget(payload);
  await s3.send(new DeleteObjectCommand({ Bucket: source.bucket, Key: source.objectKey }));
}

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
      } else if (row.type === 'artifact.source.cleanup') {
        await deleteArtifactSourceObject(context.s3, row.payload);
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
      } else if (row.type === 'reward.artifact.evaluate') {
        const submissionId =
          typeof row.payload.submissionId === 'string' ? row.payload.submissionId : row.aggregateId;
        const result = await grantArtifactReward(context.db, { submissionId });
        // Ineligible/manual policies are terminal for this trigger. An administrator can change
        // the policy and enqueue the same idempotent evaluation through reconciliation later.
        context.logger.info({ submissionId, result: result.status }, 'Artifact reward evaluated');
      } else if (notificationOutboxTypes.has(row.type)) {
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
      } else if (
        row.type === 'crm.submission.sync' ||
        row.type === 'crm.user.sync' ||
        row.type === 'crm.event.sync' ||
        row.type === 'crm.participation.sync'
      ) {
        const userSync = row.type === 'crm.user.sync';
        const eventSync = row.type === 'crm.event.sync';
        const participationSync = row.type === 'crm.participation.sync';
        await queues.crm.add(
          userSync
            ? 'sync-user-to-crm'
            : eventSync
              ? 'sync-event-to-crm'
              : participationSync
                ? 'sync-participation-to-crm'
                : 'sync-submission-to-crm',
          userSync
            ? { userId: row.aggregateId }
            : eventSync
              ? { eventId: row.aggregateId }
              : participationSync
                ? {
                    eventId: row.payload.eventId,
                    userId: row.payload.userId,
                  }
                : { submissionId: row.aggregateId },
          {
            jobId: row.id,
            attempts: 10,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1_000,
            removeOnFail: 2_000,
          },
        );
      } else {
        throw new Error(`Unsupported outbox event type: ${row.type}`);
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
