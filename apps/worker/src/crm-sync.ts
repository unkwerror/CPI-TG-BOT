import { and, eq, isNull, ne } from 'drizzle-orm';
import { artifacts, events, submissions, users } from '@cpi/db';
import type { CampaignReplyAction } from '@cpi/shared';
import type { WorkerContext } from './context';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const anyUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function crmEndpoint(context: WorkerContext, path: string): string {
  return `${context.config.CRM_API_URL.replace(/\/+$/u, '')}${path}`;
}

function crmHeaders(context: WorkerContext, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${context.config.CRM_INTEGRATION_TOKEN}`,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

async function postToCrm(
  context: WorkerContext,
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  try {
    return await fetch(crmEndpoint(context, path), {
      method: 'POST',
      headers: crmHeaders(context, idempotencyKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error('CRM integration request failed', { cause: error });
  }
}

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
  const response = await postToCrm(
    context,
    '/integrations/locker/v1/submissions',
    payload,
    `locker-submission-${submissionId}`,
  );
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

/**
 * Имя для карточки CRM. У нажавшего «Старт» своего ФИО в профиле нет, поэтому
 * берётся то, что дал Telegram. Карточку CRM создаёт только по фамилии, имени и
 * отчеству русскими буквами, поэтому имени из Telegram обычно не хватает: тогда
 * приходит 422, причина оседает в crm_sync_error и видна в списке пользователей.
 * Такого человека рассылка не увидит, пока он не заполнит профиль в приложении.
 */
export function crmDisplayName(user: {
  fullName: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
  telegramUsername: string | null;
}): string | null {
  const profileName = user.fullName?.trim();
  if (profileName) return profileName;
  const telegramName = [user.telegramFirstName, user.telegramLastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
  if (telegramName) return telegramName;
  const username = user.telegramUsername?.trim();
  return username ? `@${username}` : null;
}

/**
 * Заводит участника в CRM, чтобы он попал в аудиторию рассылки. Отказ по составу
 * данных (422/409) окончательный до изменения профиля: повторять его бессмысленно,
 * поэтому причина пишется в карточку, а задание закрывается успехом.
 */
export async function syncUserToCrm(context: WorkerContext, userId: string): Promise<boolean> {
  const [user] = await context.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return false;

  const fullName = crmDisplayName(user);
  if (!fullName) {
    await recordUserSyncError(context, userId, 'Telegram не сообщил ни имени, ни username');
    return false;
  }

  const response = await postToCrm(context, '/integrations/locker/v1/users/resolve', {
    lockerUserId: user.id,
    telegramUserId: user.telegramUserId.toString(),
    telegramUsername: user.telegramUsername,
    fullName,
    phone: user.phone,
    organization: user.organization,
    position: user.position,
    consentAt: user.consentAt?.toISOString() ?? null,
    ...(user.crmPersonId ? { crmPersonId: user.crmPersonId } : {}),
  });

  if (response.status === 422 || response.status === 409) {
    const detail = await readCrmProblem(response);
    await recordUserSyncError(context, userId, detail);
    context.logger.info({ userId, status: response.status, detail }, 'CRM postponed the person');
    return false;
  }
  if (!response.ok) throw new Error(`CRM integration returned HTTP ${response.status}`);

  const body = (await response.json()) as unknown;
  const personId = (body as { personId?: unknown } | null)?.personId;
  if (typeof personId !== 'string' || !anyUuidPattern.test(personId)) {
    throw new Error('CRM returned an invalid personId');
  }

  const conflicting = await context.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.crmPersonId, personId), ne(users.id, userId)))
    .limit(1);
  if (conflicting.length > 0) {
    // Уникальный индекс не даст записать ту же карточку второму аккаунту.
    await recordUserSyncError(
      context,
      userId,
      'Карточка CRM уже привязана к другому Telegram-аккаунту',
    );
    return false;
  }

  await context.db
    .update(users)
    .set({
      crmPersonId: personId,
      crmSyncedAt: new Date(),
      crmSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  context.logger.info({ userId, crmPersonId: personId }, 'Bot user synchronized with CRM');
  return true;
}

async function recordUserSyncError(
  context: WorkerContext,
  userId: string,
  reason: string,
): Promise<void> {
  await context.db
    .update(users)
    .set({ crmSyncError: reason.slice(0, 1_000), crmSyncedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * В ответе CRM причина отказа лежит в title, а detail — общий совет, поэтому
 * первым идёт title: без него в карточке остаётся текст, из которого непонятно,
 * что именно исправить.
 */
async function readCrmProblem(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; title?: unknown };
    const parts = [body.title, body.detail].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    const unique = [...new Set(parts)];
    return unique.length > 0 ? unique.join('. ') : `CRM отказала с кодом ${response.status}`;
  } catch {
    return `CRM отказала с кодом ${response.status}`;
  }
}

/**
 * Возвращает в CRM нажатие кнопки под сообщением рассылки. Неизвестный получатель
 * — это уже удалённая кампания, повторять такое обращение незачем.
 */
export async function reportCampaignReply(
  context: WorkerContext,
  reply: { recipientId: string; action: CampaignReplyAction },
): Promise<boolean> {
  const response = await postToCrm(context, '/integrations/campaigns/v1/replies', reply);
  if (response.status === 404) {
    context.logger.warn({ ...reply }, 'CRM does not know this campaign recipient');
    return false;
  }
  if (!response.ok) throw new Error(`CRM integration returned HTTP ${response.status}`);
  context.logger.info({ ...reply }, 'Campaign reply delivered to CRM');
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
