import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  artifacts,
  eventArtifactFields,
  events,
  exportJobs,
  outboxEvents,
  submissions,
  users,
} from '@cpi/db';
import { artifactObjectKey, evaluateFilePolicy } from '@cpi/shared';
import { grantArtifactReward } from '../../api/src/wallet-service';
import { promoteArtifactObject } from './artifact-promotion';
import type { WorkerContext } from './context';
import { hashAndOptionallyScan } from './clamav';
import { inspectFileSignature } from './file-signature';
import { configuredClamavScanner, mustQuarantineBeforeScan } from './verification-policy';

type DatabaseTransaction = Parameters<Parameters<WorkerContext['db']['transaction']>[0]>[0];

interface PromotionCommitResult {
  promoted: boolean;
  submissionReady: boolean;
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
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

async function formFileRequirementsMet(
  transaction: DatabaseTransaction,
  submissionId: string,
): Promise<boolean> {
  const [submission] = await transaction
    .select({ formVersionId: submissions.formVersionId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  if (!submission?.formVersionId) return true;
  const fields = await transaction
    .select()
    .from(eventArtifactFields)
    .where(eq(eventArtifactFields.formVersionId, submission.formVersionId));
  const fileKinds = new Set(['file', 'image', 'document', 'audio', 'video', 'archive']);
  const required = fields.filter(
    (field) => fileKinds.has(field.kind) && (field.required || field.minItems > 0),
  );
  if (required.length === 0) return true;
  const readyFiles = await transaction
    .select({ fieldId: artifacts.formFieldId })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.submissionId, submissionId),
        eq(artifacts.status, 'ready'),
        isNull(artifacts.deletedAt),
      ),
    );
  const counts = new Map<string, number>();
  for (const file of readyFiles) {
    if (file.fieldId) counts.set(file.fieldId, (counts.get(file.fieldId) ?? 0) + 1);
  }
  return required.every(
    (field) => (counts.get(field.id) ?? 0) >= Math.max(field.required ? 1 : 0, field.minItems),
  );
}

export async function verifyArtifact(context: WorkerContext, artifactId: string): Promise<void> {
  // Мероприятие и участник нужны, чтобы после проверки файл переехал в папку с
  // человеческими именами вместо идентификаторов.
  const [row] = await context.db
    .select({
      artifact: artifacts,
      eventTitle: events.title,
      userId: users.id,
      fullName: users.fullName,
      telegramUserId: users.telegramUserId,
    })
    .from(artifacts)
    .innerJoin(events, eq(events.id, artifacts.eventId))
    .innerJoin(users, eq(users.id, artifacts.userId))
    .where(and(eq(artifacts.id, artifactId), isNull(artifacts.deletedAt)))
    .limit(1);
  const artifact = row?.artifact;
  if (!row || !artifact || artifact.status === 'ready') return;
  if (!['uploaded', 'verifying', 'failed'].includes(artifact.status)) {
    throw new Error(`Artifact ${artifactId} is in ${artifact.status} state`);
  }

  const [started] = await context.db
    .update(artifacts)
    .set({ status: 'verifying', statusReason: null })
    .where(
      and(
        eq(artifacts.id, artifact.id),
        isNull(artifacts.deletedAt),
        ne(artifacts.status, 'ready'),
      ),
    )
    .returning({ id: artifacts.id });
  if (!started) return;

  try {
    const head = await context.s3.send(
      new HeadObjectCommand({
        Bucket: artifact.bucket,
        Key: artifact.objectKey,
      }),
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
    const scanner = configuredClamavScanner(context.config);
    if (mustQuarantineBeforeScan(policy.requiresQuarantine, scanner)) {
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
      new GetObjectCommand({
        Bucket: artifact.bucket,
        Key: artifact.objectKey,
      }),
    );
    if (!object.Body || !(Symbol.asyncIterator in object.Body)) {
      throw new Error('S3 object body is not streamable');
    }
    const hash = createHash('sha256');
    const scan = await hashAndOptionallyScan(
      object.Body as AsyncIterable<Uint8Array>,
      hash,
      scanner,
    );
    const checksum = hash.digest('hex');
    const signature = await inspectFileSignature(
      scan.fileHead,
      artifact.mimeType,
      artifact.extension,
    );
    if (!signature.matches && signature.detected) {
      throw new Error(
        `Содержимое файла (${signature.detected.mime}) не совпадает с заявленным типом (${artifact.mimeType})`,
      );
    }
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

    const desiredKey = artifactObjectKey(context.config.S3_PREFIX, {
      eventTitle: row.eventTitle,
      personName: row.fullName,
      telegramUserId: row.telegramUserId ?? row.userId,
      fileName: artifact.displayName,
    });
    const promotionResult = await promoteArtifactObject<DatabaseTransaction, PromotionCommitResult>(
      {
        desiredKey,
        artifactId: artifact.id,
        submissionId: artifact.submissionId,
        sizeBytes: actualSize,
        checksumSha256: checksum,
      },
      {
        withLockedTransaction: (baseKey, operation) =>
          context.db.transaction(async (transaction) => {
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`artifact-promotion:${baseKey}`}, 0))`,
            );
            return operation(transaction);
          }),
        lockCandidate: async (transaction, candidate) => {
          if (candidate === desiredKey) return;
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`artifact-promotion:${candidate}`}, 0))`,
          );
        },
        findOwner: async (transaction, candidate) => {
          const [owner] = await transaction
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(eq(artifacts.objectKey, candidate))
            .limit(1);
          return owner?.id;
        },
        headDestination: async (candidate) => {
          try {
            const destination = await context.s3.send(
              new HeadObjectCommand({
                Bucket: context.config.S3_BUCKET,
                Key: candidate,
              }),
            );
            return {
              contentLength: destination.ContentLength,
              metadata: destination.Metadata,
            };
          } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
          }
        },
        copyDestination: async (candidate) => {
          await context.s3.send(
            new CopyObjectCommand({
              Bucket: context.config.S3_BUCKET,
              Key: candidate,
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
        },
        commit: async (transaction, targetKey) => {
          const [updated] = await transaction
            .update(artifacts)
            .set({
              bucket: context.config.S3_BUCKET,
              objectKey: targetKey,
              status: 'ready',
              actualSizeBytes: actualSize,
              checksumSha256: checksum,
              statusReason: null,
              readyAt: new Date(),
            })
            .where(and(eq(artifacts.id, artifact.id), isNull(artifacts.deletedAt)))
            .returning({ id: artifacts.id });
          if (!updated) return { promoted: false, submissionReady: false };
          if (artifact.bucket !== context.config.S3_BUCKET || artifact.objectKey !== targetKey) {
            await transaction
              .insert(outboxEvents)
              .values({
                type: 'artifact.source.cleanup',
                aggregateType: 'artifact',
                aggregateId: artifact.id,
                payload: {
                  artifactId: artifact.id,
                  bucket: artifact.bucket,
                  objectKey: artifact.objectKey,
                },
              })
              .onConflictDoNothing();
          }
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
          const requirementsMet =
            notReady.length === 0 &&
            (await formFileRequirementsMet(transaction, artifact.submissionId));
          if (requirementsMet) {
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
                {
                  type: 'reward.artifact.evaluate',
                  aggregateType: 'submission',
                  aggregateId: artifact.submissionId,
                  payload: { submissionId: artifact.submissionId },
                },
              ])
              .onConflictDoNothing();
          }
          return { promoted: true, submissionReady: requirementsMet };
        },
      },
    );
    const targetKey = promotionResult.targetKey;
    const promotion = promotionResult.commitResult;
    if (!promotion.promoted) {
      await context.s3.send(
        new DeleteObjectCommand({
          Bucket: context.config.S3_BUCKET,
          Key: targetKey,
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
      if (promotion.submissionReady) {
        try {
          await grantArtifactReward(context.db, {
            submissionId: artifact.submissionId,
          });
        } catch (error) {
          // The verified file and ready submission must not be rolled back because a reward can
          // always be reconciled idempotently later by an administrator.
          context.logger.warn(
            { error, submissionId: artifact.submissionId },
            'Automatic artifact reward failed; reconciliation required',
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [failed] = await context.db
      .update(artifacts)
      .set({ status: 'failed', statusReason: message.slice(0, 2_000) })
      .where(
        and(
          eq(artifacts.id, artifact.id),
          isNull(artifacts.deletedAt),
          ne(artifacts.status, 'ready'),
        ),
      )
      .returning({ id: artifacts.id });
    if (!failed) return;
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
    const [submission] = await transaction
      .update(submissions)
      .set({ status: 'failed' })
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
