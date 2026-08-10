import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { artifacts, exportJobs, outboxEvents, submissions } from '@cpi/db';
import { evaluateFilePolicy } from '@cpi/shared';
import type { WorkerContext } from './context';
import { hashAndOptionallyScan } from './clamav';
import { markSubmissionFailed } from './submission-state';

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

async function expireEventExports(context: WorkerContext, eventId: string): Promise<void> {
  await context.db
    .update(exportJobs)
    .set({
      status: 'expired',
      expiresAt: new Date(),
      errorMessage: 'Недействительна после завершения проверки файла',
    })
    .where(
      and(
        eq(exportJobs.eventId, eventId),
        inArray(exportJobs.status, ['queued', 'processing', 'ready', 'failed']),
      ),
    );
}

export async function verifyArtifact(context: WorkerContext, artifactId: string): Promise<void> {
  const [artifact] = await context.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), isNull(artifacts.deletedAt)))
    .limit(1);
  if (!artifact || artifact.status === 'ready') return;
  if (!['uploaded', 'verifying', 'failed'].includes(artifact.status)) {
    throw new Error(`Artifact ${artifactId} is in ${artifact.status} state`);
  }

  // Заявка на проверку: перейти в `verifying` может только тот, кто увидел файл
  // ещё не взятым. Условие `<> 'ready'` пропускало и сам `verifying`, поэтому два
  // задания проверяли один файл одновременно и дважды копировали объект в S3.
  // Брошенную заявку всё же нужно перехватывать, иначе упавший воркер оставил бы
  // файл в `verifying` навсегда, поэтому старый захват старше lockDuration снимается.
  const staleClaimBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const [started] = await context.db
    .update(artifacts)
    .set({ status: 'verifying', statusReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(artifacts.id, artifact.id),
        isNull(artifacts.deletedAt),
        or(
          inArray(artifacts.status, ['uploaded', 'failed']),
          and(eq(artifacts.status, 'verifying'), lt(artifacts.updatedAt, staleClaimBefore)),
        ),
      ),
    )
    .returning({ id: artifacts.id });
  if (!started) {
    context.logger.info(
      { artifactId, status: artifact.status },
      'Artifact verification is already claimed',
    );
    return;
  }

  try {
    const head = await context.s3.send(
      new HeadObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
    );
    const actualSize = Number(head.ContentLength ?? -1);
    if (actualSize !== Number(artifact.sizeBytes)) {
      throw new Error(
        `Фактический размер ${actualSize} не совпадает с заявленным ${artifact.sizeBytes}`,
      );
    }
    if (
      head.ContentType &&
      artifact.mimeType !== 'application/octet-stream' &&
      head.ContentType !== artifact.mimeType
    ) {
      throw new Error(
        `Фактический Content-Type ${head.ContentType} не совпадает с ${artifact.mimeType}`,
      );
    }

    const policy = evaluateFilePolicy({
      fileName: artifact.originalName,
      mimeType: artifact.mimeType,
      sizeBytes: actualSize,
      maxFileSizeBytes: Number(artifact.sizeBytes),
    });
    if (!policy.allowed) throw new Error(policy.reason);
    if (policy.requiresQuarantine && context.config.FILE_VERIFICATION_MODE !== 'clamav') {
      const [quarantined] = await context.db
        .update(artifacts)
        .set({
          status: 'quarantined',
          actualSizeBytes: actualSize,
          statusReason: 'Опасный исполняемый формат оставлен в карантине: ClamAV не подключён',
        })
        .where(and(eq(artifacts.id, artifact.id), isNull(artifacts.deletedAt)))
        .returning({ id: artifacts.id });
      if (quarantined) {
        await markSubmissionFailed(context, artifact.submissionId, artifact.id);
      }
      return;
    }

    const object = await context.s3.send(
      new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
    );
    if (!object.Body || !(Symbol.asyncIterator in object.Body)) {
      throw new Error('S3 object body is not streamable');
    }
    const hash = createHash('sha256');
    const scan = await hashAndOptionallyScan(
      object.Body as AsyncIterable<Uint8Array>,
      hash,
      context.config.FILE_VERIFICATION_MODE === 'clamav' && context.config.CLAMAV_HOST
        ? { host: context.config.CLAMAV_HOST, port: context.config.CLAMAV_PORT }
        : undefined,
    );
    const checksum = hash.digest('hex');
    if (!scan.clean) {
      const [quarantined] = await context.db
        .update(artifacts)
        .set({
          status: 'quarantined',
          actualSizeBytes: actualSize,
          checksumSha256: checksum,
          statusReason: `Антивирус обнаружил угрозу: ${scan.response.slice(0, 500)}`,
        })
        .where(and(eq(artifacts.id, artifact.id), isNull(artifacts.deletedAt)))
        .returning({ id: artifacts.id });
      if (quarantined) {
        await markSubmissionFailed(context, artifact.submissionId, artifact.id);
      }
      return;
    }

    await context.s3.send(
      new CopyObjectCommand({
        Bucket: context.config.S3_PRIVATE_BUCKET,
        Key: artifact.objectKey,
        CopySource: copySource(artifact.bucket, artifact.objectKey),
        ContentType: artifact.mimeType,
        MetadataDirective: 'REPLACE',
        Metadata: {
          artifact: artifact.id,
          submission: artifact.submissionId,
          sha256: checksum,
        },
      }),
    );
    await context.s3.send(
      new DeleteObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
    );

    const promoted = await context.db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(artifacts)
        .set({
          bucket: context.config.S3_PRIVATE_BUCKET,
          status: 'ready',
          actualSizeBytes: actualSize,
          checksumSha256: checksum,
          statusReason: null,
          readyAt: new Date(),
        })
        .where(and(eq(artifacts.id, artifact.id), isNull(artifacts.deletedAt)))
        .returning({ id: artifacts.id });
      if (!updated) return false;
      await transaction.execute(
        sql`select id from ${submissions} where ${submissions.id} = ${artifact.submissionId} for update`,
      );
      const notReady = await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.submissionId, artifact.submissionId),
            isNull(artifacts.deletedAt),
            ne(artifacts.status, 'ready'),
            ne(artifacts.id, artifact.id),
          ),
        )
        .limit(1);
      if (notReady.length === 0) {
        await transaction
          .update(submissions)
          .set({ status: 'ready', submittedAt: new Date() })
          .where(eq(submissions.id, artifact.submissionId));
        await transaction
          .insert(outboxEvents)
          .values([
            {
              type: 'submission.ready',
              aggregateType: 'submission',
              aggregateId: artifact.submissionId,
              payload: { submissionId: artifact.submissionId },
            },
            {
              type: 'crm.submission.sync',
              aggregateType: 'submission',
              aggregateId: artifact.submissionId,
              payload: { submissionId: artifact.submissionId },
            },
          ])
          .onConflictDoNothing();
      }
      return true;
    });
    if (!promoted) {
      await context.s3.send(
        new DeleteObjectCommand({
          Bucket: context.config.S3_PRIVATE_BUCKET,
          Key: artifact.objectKey,
        }),
      );
    } else {
      try {
        await expireEventExports(context, artifact.eventId);
      } catch (error) {
        context.logger.warn(
          { error, eventId: artifact.eventId },
          'Export invalidation after artifact verification failed',
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [failed] = await context.db
      .update(artifacts)
      .set({ status: 'failed', statusReason: message.slice(0, 2_000) })
      .where(and(eq(artifacts.id, artifact.id), isNull(artifacts.deletedAt)))
      .returning({ id: artifacts.id });
    if (!failed) return;
    await markSubmissionFailed(context, artifact.submissionId, artifact.id);
    throw error;
  }
}
