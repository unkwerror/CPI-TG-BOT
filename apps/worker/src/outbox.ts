import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { outboxEvents } from '@cpi/db';
import type { WorkerContext } from './context';

/**
 * BullMQ молча игнорирует add с уже известным jobId, а выполненные задания
 * остаются в Redis. Поэтому переоткрытое событие с прежним ключом никогда не
 * выполнялось повторно: кнопка «Отправить в CRM» отмечала событие обработанным,
 * но задание не запускалось. availableAt меняется при каждом переоткрытии и
 * повторе, зато одинаков для двух диспетчеров, поднявших одну и ту же строку,
 * поэтому даёт новый ключ ровно на одно исполнение. Двоеточие в ключе BullMQ
 * запрещает — им разделяются собственные ключи Redis.
 */
export function outboxJobId(row: { id: string; availableAt: Date }): string {
  return `${row.id}-${row.availableAt.getTime()}`;
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
            jobId: outboxJobId(row),
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
            jobId: outboxJobId(row),
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 200,
            removeOnFail: 500,
          },
        );
      } else if (
        row.type === 'submission.ready' ||
        row.type === 'artifact.failed' ||
        row.type === 'event_request.created'
      ) {
        await queues.notifications.add(
          'send-notification',
          { type: row.type, ...row.payload },
          {
            jobId: outboxJobId(row),
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
            jobId: outboxJobId(row),
            attempts: 10,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1_000,
            removeOnFail: 2_000,
          },
        );
      } else if (row.type === 'crm.user.sync') {
        await queues.crm.add(
          'sync-user-to-crm',
          { userId: row.aggregateId },
          {
            jobId: outboxJobId(row),
            attempts: 10,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1_000,
            removeOnFail: 2_000,
          },
        );
      } else if (row.type === 'crm.campaign.reply') {
        await queues.crm.add('report-campaign-reply', row.payload, {
          jobId: outboxJobId(row),
          attempts: 10,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 2_000,
        });
      } else {
        // Неизвестный тип раньше помечался обработанным и терялся навсегда.
        // Оставляем строку непрочитанной с причиной: её видно и можно доставить
        // после исправления, а не искать пропажу по логам.
        throw new Error(`Unknown outbox event type ${row.type}`);
      }
      await context.db
        .update(outboxEvents)
        .set({ processedAt: new Date(), lastError: null })
        .where(and(eq(outboxEvents.id, row.id), isNull(outboxEvents.processedAt)));
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Backoff растёт до шести часов: постоянная ошибка не должна вечно
      // повторяться каждые пять минут, но и терять событие нельзя.
      const delaySeconds = Math.min(21_600, 2 ** Math.min(row.attempts, 15));
      const attempts = row.attempts + 1;
      await context.db
        .update(outboxEvents)
        .set({
          attempts,
          lastError: message.slice(0, 2_000),
          availableAt: new Date(Date.now() + delaySeconds * 1_000),
        })
        .where(eq(outboxEvents.id, row.id));
      const details = { error, outboxId: row.id, type: row.type, attempts };
      if (attempts >= 10) context.logger.error(details, 'Outbox event keeps failing');
      else context.logger.warn(details, 'Outbox dispatch failed');
    }
  }
  return processed;
}
