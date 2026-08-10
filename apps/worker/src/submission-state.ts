import { and, eq, isNull } from 'drizzle-orm';
import { outboxEvents, submissions } from '@cpi/db';
import type { WorkerContext } from './context';

/**
 * Переводит отправку в «ошибку» и ставит уведомление в outbox. Без этого шага
 * отправка остаётся в статусе `processing` навсегда, а приложение бесконечно
 * показывает «Проверяется» и продолжает опрашивать сервер.
 */
export async function markSubmissionFailed(
  context: WorkerContext,
  submissionId: string,
  artifactId: string,
): Promise<void> {
  await context.db.transaction(async (transaction) => {
    const [submission] = await transaction
      .update(submissions)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(and(eq(submissions.id, submissionId), isNull(submissions.deletedAt)))
      .returning({ id: submissions.id });
    if (!submission) return;
    await transaction
      .insert(outboxEvents)
      .values({
        type: 'artifact.failed',
        aggregateType: 'artifact',
        aggregateId: artifactId,
        payload: { artifactId, submissionId },
      })
      .onConflictDoNothing();
  });
}
