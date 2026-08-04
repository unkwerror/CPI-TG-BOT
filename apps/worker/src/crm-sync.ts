import { and, eq, isNull } from 'drizzle-orm';
import { artifacts, events, submissions, users } from '@cpi/db';
import type { WorkerContext } from './context';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface CrmSyncResponse {
  personId: string;
  eventId: string;
  artifactId: string;
  artifactVersionId: string;
  replayed: boolean;
}

export async function syncSubmissionToCrm(
  context: WorkerContext,
  submissionId: string,
): Promise<boolean> {
  const [record] = await context.db
    .select({ submission: submissions, user: users, event: events })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.userId))
    .innerJoin(events, eq(events.id, submissions.eventId))
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.status, 'ready'),
        isNull(submissions.deletedAt),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  if (!record) return false;
  if (record.submission.crmSyncedAt) return false;
  if (!record.user.fullName) throw new Error('Locker user profile has no full name');
  if (!record.submission.submittedAt) throw new Error('Ready submission has no submittedAt');

  const files = await context.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.submissionId, submissionId), isNull(artifacts.deletedAt)));
  const unavailable = files.find(
    (file) => file.status !== 'ready' || !file.checksumSha256 || !file.readyAt,
  );
  if (unavailable) throw new Error(`Locker artifact ${unavailable.id} is not ready for CRM sync`);

  const payload = buildCrmSyncPayload(record, files);
  const endpoint = `${context.config.CRM_API_URL.replace(/\/+$/u, '')}/integrations/locker/v1/submissions`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.config.CRM_INTEGRATION_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': `locker-submission-${submissionId}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error('CRM integration request failed', { cause: error });
  }
  if (!response.ok) {
    throw new Error(`CRM integration returned HTTP ${response.status}`);
  }
  const result = validateCrmSyncResponse((await response.json()) as unknown);
  await context.db.transaction(async (transaction) => {
    await transaction
      .update(users)
      .set({ crmPersonId: result.personId, updatedAt: new Date() })
      .where(eq(users.id, record.user.id));
    await transaction
      .update(submissions)
      .set({
        crmArtifactId: result.artifactId,
        crmArtifactVersionId: result.artifactVersionId,
        crmSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(submissions.id, submissionId));
  });
  context.logger.info(
    {
      submissionId,
      crmPersonId: result.personId,
      crmArtifactVersionId: result.artifactVersionId,
      replayed: result.replayed,
    },
    'Locker submission synchronized with CRM',
  );
  return true;
}

export function buildCrmSyncPayload(
  record: {
    submission: typeof submissions.$inferSelect;
    user: typeof users.$inferSelect;
    event: typeof events.$inferSelect;
  },
  files: Array<typeof artifacts.$inferSelect>,
) {
  const { submission, user, event } = record;
  if (!submission.submittedAt || !user.fullName) {
    throw new Error('CRM sync payload requires fullName and submittedAt');
  }
  return {
    schemaVersion: 1 as const,
    user: {
      lockerUserId: user.id,
      telegramUserId: user.telegramUserId.toString(),
      telegramUsername: user.telegramUsername,
      fullName: user.fullName,
      phone: user.phone,
      organization: user.organization,
      position: user.position,
      consentAt: user.consentAt?.toISOString() ?? null,
      ...(user.crmPersonId ? { crmPersonId: user.crmPersonId } : {}),
    },
    event: {
      lockerEventId: event.id,
      title: event.title,
      status: event.status,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
    },
    submission: {
      lockerSubmissionId: submission.id,
      title: submission.title,
      text: submission.text,
      link: submission.link,
      createdAt: submission.createdAt.toISOString(),
      submittedAt: submission.submittedAt.toISOString(),
      files: [...files]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((file) => ({
          lockerArtifactId: file.id,
          originalName: file.originalName,
          mimeType: file.mimeType,
          sizeBytes: Number(file.actualSizeBytes ?? file.sizeBytes),
          checksumSha256: file.checksumSha256!,
          readyAt: file.readyAt!.toISOString(),
        })),
    },
  };
}

export function validateCrmSyncResponse(value: unknown): CrmSyncResponse {
  if (!value || typeof value !== 'object') throw new Error('CRM returned an invalid response');
  const input = value as Record<string, unknown>;
  for (const field of ['personId', 'eventId', 'artifactId', 'artifactVersionId'] as const) {
    if (typeof input[field] !== 'string' || !uuidPattern.test(input[field])) {
      throw new Error(`CRM returned an invalid ${field}`);
    }
  }
  return {
    personId: input.personId as string,
    eventId: input.eventId as string,
    artifactId: input.artifactId as string,
    artifactVersionId: input.artifactVersionId as string,
    replayed: input.replayed === true,
  };
}
