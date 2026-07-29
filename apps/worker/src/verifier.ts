import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { artifacts, outboxEvents, submissions } from '@cpi/db';
import { evaluateFilePolicy } from '@cpi/shared';
import type { WorkerContext } from './context';
import { hashAndOptionallyScan } from './clamav';

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

export async function verifyArtifact(
  context: WorkerContext,
  artifactId: string,
): Promise<void> {
  const [artifact] = await context.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), isNull(artifacts.deletedAt)))
    .limit(1);
  if (!artifact || artifact.status === 'ready') return;
  if (!['uploaded', 'verifying', 'failed'].includes(artifact.status)) {
    throw new Error(`Artifact ${artifactId} is in ${artifact.status} state`);
  }

  await context.db
    .update(artifacts)
    .set({ status: 'verifying', statusReason: null })
    .where(and(eq(artifacts.id, artifact.id), ne(artifacts.status, 'ready')));

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
      await context.db
        .update(artifacts)
        .set({
          status: 'quarantined',
          actualSizeBytes: actualSize,
          statusReason:
            'Опасный исполняемый формат оставлен в карантине: ClamAV не подключён',
        })
        .where(eq(artifacts.id, artifact.id));
      await markSubmissionFailed(context, artifact.submissionId, artifact.id);
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
      await context.db
        .update(artifacts)
        .set({
          status: 'quarantined',
          actualSizeBytes: actualSize,
          checksumSha256: checksum,
          statusReason: `Антивирус обнаружил угрозу: ${scan.response.slice(0, 500)}`,
        })
        .where(eq(artifacts.id, artifact.id));
      await markSubmissionFailed(context, artifact.submissionId, artifact.id);
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

    await context.db.transaction(async (transaction) => {
      await transaction
        .update(artifacts)
        .set({
          bucket: context.config.S3_PRIVATE_BUCKET,
          status: 'ready',
          actualSizeBytes: actualSize,
          checksumSha256: checksum,
          statusReason: null,
          readyAt: new Date(),
        })
        .where(eq(artifacts.id, artifact.id));
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
          .values({
            type: 'submission.ready',
            aggregateType: 'submission',
            aggregateId: artifact.submissionId,
            payload: { submissionId: artifact.submissionId },
          })
          .onConflictDoNothing();
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.db
      .update(artifacts)
      .set({ status: 'failed', statusReason: message.slice(0, 2_000) })
      .where(eq(artifacts.id, artifact.id));
    await markSubmissionFailed(context, artifact.submissionId, artifact.id);
    throw error;
  }
}

async function markSubmissionFailed(
  context: WorkerContext,
  submissionId: string,
  artifactId: string,
): Promise<void> {
  await context.db.transaction(async (transaction) => {
    await transaction
      .update(submissions)
      .set({ status: 'failed' })
      .where(eq(submissions.id, submissionId));
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
