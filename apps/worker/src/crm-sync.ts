import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  artifacts,
  eventParticipants,
  events,
  submissions,
  userMessengerIdentities,
  users,
} from '@cpi/db';
import { isCrmReadyFullName } from '@cpi/shared';
import type { WorkerContext } from './context';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface CrmSyncResponse {
  personId: string;
  eventId: string;
  artifactId: string;
  artifactVersionId: string;
  taskId?: string;
  replayed: boolean;
}

interface CrmUserSyncResponse {
  personId: string;
  resolution: string;
}

interface CrmEventSyncResponse {
  eventId: string;
}

interface CrmParticipationSyncResponse {
  personId: string;
  eventId: string;
  participantAdded: boolean;
}

export interface CrmCatalogEvent {
  crmEventId: string;
  lockerEventId: string;
  title: string;
  status: 'draft' | 'published' | 'running' | 'finished' | 'archived';
  startsAt: string;
  endsAt: string;
  updatedAt: string;
  datesInferred: boolean;
  archived: boolean;
  origin: 'CRM' | 'LOCKER';
}

type MessengerIdentity = typeof userMessengerIdentities.$inferSelect;

async function loadMessengerIdentities(
  context: WorkerContext,
  userId: string,
): Promise<MessengerIdentity[]> {
  return context.db
    .select()
    .from(userMessengerIdentities)
    .where(eq(userMessengerIdentities.userId, userId))
    .orderBy(asc(userMessengerIdentities.provider));
}

export function buildCrmUserPayload(
  user: typeof users.$inferSelect,
  identities: MessengerIdentity[] = [],
) {
  const telegramIdentity = identities.find((identity) => identity.provider === 'telegram');
  const maxIdentity = identities.find((identity) => identity.provider === 'max');
  const fullName = user.fullName?.trim();
  const messengerName = [
    user.telegramFirstName ?? telegramIdentity?.firstName ?? maxIdentity?.firstName,
    user.telegramLastName ?? telegramIdentity?.lastName ?? maxIdentity?.lastName,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();
  const username = user.telegramUsername ?? telegramIdentity?.username ?? maxIdentity?.username;
  const fallbackIdentity = telegramIdentity ?? maxIdentity;
  const provider = telegramIdentity
    ? 'telegram'
    : maxIdentity
      ? 'max'
      : user.telegramUserId
        ? 'telegram'
        : 'max';
  const externalUserId =
    fallbackIdentity?.externalUserId ?? user.telegramUserId?.toString() ?? user.id;
  const displayName =
    fullName ||
    messengerName ||
    (username?.trim() ? `@${username.trim().replace(/^@/u, '')}` : '') ||
    `${provider === 'max' ? 'MAX' : 'Telegram'} ID ${externalUserId}`;
  return {
    lockerUserId: user.id,
    messengerProvider: provider,
    messengerUserId: externalUserId,
    ...(user.telegramUserId ? { telegramUserId: user.telegramUserId.toString() } : {}),
    ...(maxIdentity ? { maxUserId: maxIdentity.externalUserId } : {}),
    telegramUsername: user.telegramUsername,
    maxUsername: maxIdentity?.username ?? null,
    messengerIdentities: identities.map((identity) => ({
      provider: identity.provider,
      externalUserId: identity.externalUserId,
      username: identity.username,
    })),
    fullName: displayName,
    phone: user.phone,
    organization: user.organization,
    position: user.position,
    consentAt: user.consentAt?.toISOString() ?? null,
    profileIncomplete: !isCrmReadyFullName(fullName),
    ...(user.crmPersonId ? { crmPersonId: user.crmPersonId } : {}),
  };
}

export function buildCrmEventPayload(event: typeof events.$inferSelect) {
  return {
    lockerEventId: event.id,
    title: event.title,
    status: event.deletedAt ? ('archived' as const) : event.status,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    managedByCrm: event.managedByCrm,
  };
}

/** Синхронизация профиля не зависит от наличия отправок у пользователя. */
export async function syncUserToCrm(context: WorkerContext, userId: string): Promise<boolean> {
  const [user] = await context.db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'active')))
    .limit(1);
  if (!user) return false;
  const identities = await loadMessengerIdentities(context, user.id);
  const endpoint = `${context.config.CRM_API_URL.replace(/\/+$/u, '')}/integrations/locker/v1/users/resolve`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.config.CRM_INTEGRATION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildCrmUserPayload(user, identities)),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error('CRM user integration request failed', { cause: error });
  }
  if (!response.ok) {
    const message = `CRM user integration returned HTTP ${response.status}`;
    if (isRetryableStatus(response.status)) throw new Error(message);
    context.logger.warn({ userId, status: response.status }, 'CRM rejected Locker user profile');
    return false;
  }
  const result = validateCrmUserSyncResponse((await response.json()) as unknown);
  await context.db
    .update(users)
    .set({ crmPersonId: result.personId, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  context.logger.info(
    { userId, crmPersonId: result.personId, resolution: result.resolution },
    'Locker user profile synchronized with CRM',
  );
  return true;
}

/** Одноразовый безопасный backfill текущей базы: ошибки одного профиля не останавливают остальные. */
export async function syncAllActiveUsersToCrm(context: WorkerContext): Promise<{
  total: number;
  synchronized: number;
  failed: number;
}> {
  const rows = await context.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));
  let synchronized = 0;
  let failed = 0;
  for (const user of rows) {
    try {
      if (await syncUserToCrm(context, user.id)) synchronized += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      context.logger.warn({ error, userId: user.id }, 'CRM user backfill failed');
    }
  }
  return { total: rows.length, synchronized, failed };
}

export async function syncEventToCrm(context: WorkerContext, eventId: string): Promise<boolean> {
  const [event] = await context.db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.managedByCrm, false)))
    .limit(1);
  if (!event) return false;
  const endpoint = `${context.config.CRM_API_URL.replace(/\/+$/u, '')}/integrations/locker/v1/events/resolve`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.config.CRM_INTEGRATION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        event: buildCrmEventPayload(event),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error('CRM event integration request failed', { cause: error });
  }
  if (!response.ok) {
    const message = `CRM event integration returned HTTP ${response.status}`;
    if (isRetryableStatus(response.status)) throw new Error(message);
    context.logger.warn({ eventId, status: response.status }, 'CRM rejected Locker event');
    return false;
  }
  validateCrmEventSyncResponse((await response.json()) as unknown);
  context.logger.info({ eventId }, 'Locker event synchronized with CRM');
  return true;
}

export async function syncParticipationToCrm(
  context: WorkerContext,
  eventId: string,
  userId: string,
): Promise<boolean> {
  const [record] = await context.db
    .select({ participation: eventParticipants, user: users, event: events })
    .from(eventParticipants)
    .innerJoin(users, eq(users.id, eventParticipants.userId))
    .innerJoin(events, eq(events.id, eventParticipants.eventId))
    .where(
      and(
        eq(eventParticipants.eventId, eventId),
        eq(eventParticipants.userId, userId),
        eq(users.status, 'active'),
      ),
    )
    .limit(1);
  if (!record) return false;
  const identities = await loadMessengerIdentities(context, record.user.id);
  const endpoint = `${context.config.CRM_API_URL.replace(/\/+$/u, '')}/integrations/locker/v1/participations`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.config.CRM_INTEGRATION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        user: buildCrmUserPayload(record.user, identities),
        event: buildCrmEventPayload(record.event),
        registeredAt: record.participation.joinedAt.toISOString(),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error('CRM participation integration request failed', {
      cause: error,
    });
  }
  if (!response.ok) {
    const message = `CRM participation integration returned HTTP ${response.status}`;
    if (isRetryableStatus(response.status)) throw new Error(message);
    context.logger.warn(
      { eventId, userId, status: response.status },
      'CRM rejected Locker event participation',
    );
    return false;
  }
  const result = validateCrmParticipationSyncResponse((await response.json()) as unknown);
  await context.db
    .update(users)
    .set({ crmPersonId: result.personId, updatedAt: new Date() })
    .where(eq(users.id, userId));
  context.logger.info(
    { eventId, userId, participantAdded: result.participantAdded },
    'Locker event participation synchronized with CRM',
  );
  return true;
}

export async function syncAllLockerEventsToCrm(
  context: WorkerContext,
): Promise<{ total: number; synchronized: number; failed: number }> {
  const rows = await context.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.managedByCrm, false));
  let synchronized = 0;
  let failed = 0;
  for (const event of rows) {
    try {
      if (await syncEventToCrm(context, event.id)) synchronized += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      context.logger.warn({ error, eventId: event.id }, 'CRM event backfill failed');
    }
  }
  return { total: rows.length, synchronized, failed };
}

export async function syncAllParticipationsToCrm(
  context: WorkerContext,
): Promise<{ total: number; synchronized: number; failed: number }> {
  const rows = await context.db
    .select({
      eventId: eventParticipants.eventId,
      userId: eventParticipants.userId,
    })
    .from(eventParticipants);
  let synchronized = 0;
  let failed = 0;
  for (const participation of rows) {
    try {
      if (await syncParticipationToCrm(context, participation.eventId, participation.userId)) {
        synchronized += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      context.logger.warn({ error, ...participation }, 'CRM participation backfill failed');
    }
  }
  return { total: rows.length, synchronized, failed };
}

/**
 * Восстанавливает готовые отправки, для которых outbox/BullMQ-задача была
 * потеряна или исчерпала временные повторы. Терминальные 4xx и ручная очередь
 * не трогаются: у них уже записаны crmSyncError или crmPendingReviewAt.
 */
export async function syncReadySubmissionsToCrm(
  context: WorkerContext,
  limit = 100,
): Promise<{
  total: number;
  synchronized: number;
  skipped: number;
  failed: number;
}> {
  const rows = await context.db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.status, 'ready'),
        isNull(submissions.deletedAt),
        isNull(submissions.crmSyncedAt),
        isNull(submissions.crmPendingReviewAt),
        isNull(submissions.crmSyncError),
      ),
    )
    .orderBy(asc(submissions.submittedAt), asc(submissions.id))
    .limit(Math.max(1, Math.min(limit, 500)));
  let synchronized = 0;
  let skipped = 0;
  let failed = 0;
  for (const submission of rows) {
    try {
      if (await syncSubmissionToCrm(context, submission.id)) synchronized += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      context.logger.warn(
        { error, submissionId: submission.id },
        'CRM submission reconciliation failed',
      );
    }
  }
  return { total: rows.length, synchronized, skipped, failed };
}

export async function pullCrmEventsIntoLocker(context: WorkerContext): Promise<{
  received: number;
  imported: number;
  updated: number;
  skipped: number;
}> {
  const endpoint = `${context.config.CRM_API_URL.replace(/\/+$/u, '')}/integrations/locker/v1/events?limit=1000`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${context.config.CRM_INTEGRATION_TOKEN}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error('CRM event catalog request failed', { cause: error });
  }
  if (!response.ok) {
    throw new Error(`CRM event catalog returned HTTP ${response.status}`);
  }
  const catalog = validateCrmEventCatalog((await response.json()) as unknown);
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of catalog) {
    if (item.origin !== 'CRM') {
      skipped += 1;
      continue;
    }
    const startsAt = new Date(item.startsAt);
    const rawEndsAt = new Date(item.endsAt);
    const endsAt = rawEndsAt > startsAt ? rawEndsAt : new Date(startsAt.getTime() + 60 * 60 * 1000);
    const [existing] = await context.db
      .select({ id: events.id, managedByCrm: events.managedByCrm })
      .from(events)
      .where(eq(events.id, item.lockerEventId))
      .limit(1);
    if (existing && !existing.managedByCrm) {
      skipped += 1;
      context.logger.warn(
        { eventId: item.lockerEventId },
        'CRM event id collides with a Locker-owned event',
      );
      continue;
    }
    const status: 'draft' | 'archived' = item.archived ? 'archived' : 'draft';
    const tags = ['CRM', `CRM:${item.status.toUpperCase()}`];
    const description = item.datesInferred
      ? 'Синхронизировано из CRM. Даты в CRM указаны не полностью и показаны технически.'
      : 'Синхронизировано из CRM.';
    const values = {
      title: item.title,
      description,
      organizer: 'CRM ЦПИ',
      startsAt,
      endsAt,
      status,
      tags,
      searchText: `${item.title} CRM ЦПИ ${tags.join(' ')}`,
      acceptUploadsFrom: startsAt,
      acceptUploadsUntil: endsAt,
      directAccessEnabled: false,
      managedByCrm: true,
      updatedAt: new Date(),
    };
    if (existing) {
      await context.db
        .update(events)
        .set(values)
        .where(and(eq(events.id, item.lockerEventId), eq(events.managedByCrm, true)));
      updated += 1;
      continue;
    }
    const compactId = item.lockerEventId.replaceAll('-', '');
    await context.db.insert(events).values({
      id: item.lockerEventId,
      slug: `crm-${item.lockerEventId}`,
      shortCode: `CRM_${compactId.slice(0, 20).toUpperCase()}`,
      format: 'offline',
      maxFileSizeBytes: 500 * 1024 ** 2,
      allowedMimeTypes: [],
      blockedExtensions: ['exe', 'bat', 'cmd', 'msi'],
      ...values,
    });
    imported += 1;
  }
  return { received: catalog.length, imported, updated, skipped };
}

/**
 * Повторять имеет смысл только то, что может пройти позже: недоступность CRM,
 * таймауты и лимиты. Остальные 4xx повторами не лечатся, поэтому очередь их
 * больше не долбит — ошибка остаётся на отправке и видна администратору.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
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
  if (!record.submission.submittedAt) throw new Error('Ready submission has no submittedAt');
  const files = await context.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.submissionId, submissionId), isNull(artifacts.deletedAt)));
  const unavailable = files.find(
    (file) => file.status !== 'ready' || !file.checksumSha256 || !file.readyAt,
  );
  if (unavailable) throw new Error(`Locker artifact ${unavailable.id} is not ready for CRM sync`);

  const identities = await loadMessengerIdentities(context, record.user.id);
  const payload = buildCrmSyncPayload(record, files, identities);
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
  if (response.status === 202) {
    // CRM не смогла определить участника и положила отправку в очередь разбора.
    // Материалы не потеряны, повторять запрос бессмысленно.
    const parked = (await response.json().catch(() => ({}))) as {
      reasonCode?: string;
    };
    await context.db
      .update(submissions)
      .set({
        crmPendingReviewAt: new Date(),
        crmSyncError: null,
        crmSyncFailedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(submissions.id, submissionId));
    context.logger.warn(
      { submissionId, reasonCode: parked.reasonCode },
      'CRM accepted Locker submission for manual review',
    );
    return false;
  }
  if (!response.ok) {
    const message = `CRM integration returned HTTP ${response.status}`;
    if (isRetryableStatus(response.status)) throw new Error(message);
    await context.db
      .update(submissions)
      .set({
        crmSyncError: message,
        crmSyncFailedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(submissions.id, submissionId));
    context.logger.error(
      { submissionId, status: response.status },
      'CRM rejected Locker submission',
    );
    return false;
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
        crmTaskId: result.taskId ?? null,
        crmSyncedAt: new Date(),
        crmPendingReviewAt: null,
        crmSyncError: null,
        crmSyncFailedAt: null,
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
  identities: MessengerIdentity[] = [],
) {
  const { submission, user, event } = record;
  if (!submission.submittedAt) throw new Error('CRM sync payload requires submittedAt');
  return {
    schemaVersion: 1 as const,
    user: buildCrmUserPayload(user, identities),
    event: {
      ...buildCrmEventPayload(event),
    },
    submission: {
      lockerSubmissionId: submission.id,
      title: submission.title,
      text: submission.text,
      link: submission.link,
      createdAt: submission.createdAt.toISOString(),
      submittedAt: submission.submittedAt.toISOString(),
      sourceKind: submission.sourceKind,
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
  if (
    input.taskId !== undefined &&
    (typeof input.taskId !== 'string' || !uuidPattern.test(input.taskId))
  ) {
    throw new Error('CRM returned an invalid taskId');
  }
  return {
    personId: input.personId as string,
    eventId: input.eventId as string,
    artifactId: input.artifactId as string,
    artifactVersionId: input.artifactVersionId as string,
    ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}),
    replayed: input.replayed === true,
  };
}

export function validateCrmUserSyncResponse(value: unknown): CrmUserSyncResponse {
  if (!value || typeof value !== 'object') throw new Error('CRM returned an invalid user response');
  const input = value as Record<string, unknown>;
  if (typeof input.personId !== 'string' || !uuidPattern.test(input.personId)) {
    throw new Error('CRM returned an invalid personId');
  }
  return {
    personId: input.personId,
    resolution: typeof input.resolution === 'string' ? input.resolution : 'UNKNOWN',
  };
}

export function validateCrmEventSyncResponse(value: unknown): CrmEventSyncResponse {
  if (!value || typeof value !== 'object')
    throw new Error('CRM returned an invalid event response');
  const input = value as Record<string, unknown>;
  if (typeof input.eventId !== 'string' || !uuidPattern.test(input.eventId)) {
    throw new Error('CRM returned an invalid eventId');
  }
  return { eventId: input.eventId };
}

export function validateCrmParticipationSyncResponse(value: unknown): CrmParticipationSyncResponse {
  if (!value || typeof value !== 'object')
    throw new Error('CRM returned an invalid participation response');
  const input = value as Record<string, unknown>;
  for (const field of ['personId', 'eventId'] as const) {
    if (typeof input[field] !== 'string' || !uuidPattern.test(input[field])) {
      throw new Error(`CRM returned an invalid ${field}`);
    }
  }
  return {
    personId: input.personId as string,
    eventId: input.eventId as string,
    participantAdded: input.participantAdded === true,
  };
}

export function validateCrmEventCatalog(value: unknown): CrmCatalogEvent[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) {
    throw new Error('CRM returned an invalid event catalog');
  }
  const allowedStatuses = new Set(['draft', 'published', 'running', 'finished', 'archived']);
  return (value as { items: unknown[] }).items.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`CRM returned an invalid event catalog item ${index}`);
    }
    const item = raw as Record<string, unknown>;
    for (const field of ['crmEventId', 'lockerEventId'] as const) {
      if (typeof item[field] !== 'string' || !uuidPattern.test(item[field])) {
        throw new Error(`CRM returned an invalid ${field}`);
      }
    }
    if (typeof item.title !== 'string' || !item.title.trim()) {
      throw new Error('CRM returned an invalid event title');
    }
    if (typeof item.status !== 'string' || !allowedStatuses.has(item.status)) {
      throw new Error('CRM returned an invalid event status');
    }
    for (const field of ['startsAt', 'endsAt', 'updatedAt'] as const) {
      if (typeof item[field] !== 'string' || Number.isNaN(Date.parse(item[field]))) {
        throw new Error(`CRM returned an invalid ${field}`);
      }
    }
    if (item.origin !== 'CRM' && item.origin !== 'LOCKER') {
      throw new Error('CRM returned an invalid event origin');
    }
    return {
      crmEventId: item.crmEventId as string,
      lockerEventId: item.lockerEventId as string,
      title: item.title.trim(),
      status: item.status as CrmCatalogEvent['status'],
      startsAt: item.startsAt as string,
      endsAt: item.endsAt as string,
      updatedAt: item.updatedAt as string,
      datesInferred: item.datesInferred === true,
      archived: item.archived === true,
      origin: item.origin,
    };
  });
}
