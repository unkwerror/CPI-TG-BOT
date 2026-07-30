import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import {
  artifacts,
  auditLogs,
  eventParticipants,
  events,
  exportJobs,
  submissions,
  users,
} from '@cpi/db';
import {
  AppError,
  artifactStatuses,
  eventShortCodeFromTitle,
  eventSlugFromTitle,
  eventCreateSchema,
  eventUpdateSchema,
  paginationQuerySchema,
  parseCursorPagination,
} from '@cpi/shared';
import { writeAudit } from '../audit';
import {
  serializeArtifact,
  serializeEvent,
  serializeSubmission,
  serializeUser,
} from '../serializers';
import { deleteArtifactObjects } from '../artifact-storage';
import { purgeEventStorage, purgeStoredObjects, type StoredObjectTarget } from '../event-storage';
import { invalidateEventExports } from '../export-storage';

const participantQuerySchema = paginationQuerySchema.extend({
  eventId: z.uuid().optional(),
});

const eventParticipantParamsSchema = z.object({
  eventId: z.uuid(),
  userId: z.uuid(),
});

const artifactQuerySchema = paginationQuerySchema.extend({
  eventId: z.uuid().optional(),
  status: z.enum(artifactStatuses).optional(),
});

const statusUpdateSchema = z.object({
  status: z.enum(artifactStatuses),
  reason: z.string().trim().max(2_000).nullable().optional(),
});

const EVENT_TIME_ZONE = 'Asia/Novosibirsk';
const eventTitleSchema = z.string().trim().min(2).max(300);

function identifierWithSuffix(base: string, suffix: number, maximum: number, separator: string) {
  if (suffix === 1) return base;
  const ending = `${separator}${suffix}`;
  return `${base.slice(0, maximum - ending.length)}${ending}`;
}

function validateEventDateRanges(values: {
  startsAt: Date;
  endsAt: Date;
  acceptUploadsFrom: Date;
  acceptUploadsUntil: Date;
}) {
  if (values.endsAt <= values.startsAt) {
    throw new AppError(
      'EVENT_DATE_RANGE_INVALID',
      'Окончание мероприятия должно быть позже начала',
    );
  }
  if (values.acceptUploadsUntil <= values.acceptUploadsFrom) {
    throw new AppError(
      'EVENT_ACCEPTANCE_RANGE_INVALID',
      'Окончание приёма должно быть позже его начала',
    );
  }
}

async function uniqueEventIdentifiers(
  app: Parameters<FastifyPluginAsync>[0],
  title: string,
  excludedEventId?: string,
): Promise<{ slug: string; shortCode: string }> {
  const rows = await app.db
    .select({ id: events.id, slug: events.slug, shortCode: events.shortCode })
    .from(events);
  const usedSlugs = new Set(
    rows.filter((event) => event.id !== excludedEventId).map((event) => event.slug),
  );
  const usedCodes = new Set(
    rows.filter((event) => event.id !== excludedEventId).map((event) => event.shortCode),
  );
  const slugBase = eventSlugFromTitle(title);
  const codeBase = eventShortCodeFromTitle(title);
  let slugIndex = 1;
  let slug = identifierWithSuffix(slugBase, slugIndex, 100, '-');
  while (usedSlugs.has(slug)) {
    slugIndex += 1;
    slug = identifierWithSuffix(slugBase, slugIndex, 100, '-');
  }
  let codeIndex = 1;
  let shortCode = identifierWithSuffix(codeBase, codeIndex, 24, '_');
  while (usedCodes.has(shortCode)) {
    codeIndex += 1;
    shortCode = identifierWithSuffix(codeBase, codeIndex, 24, '_');
  }
  return { slug, shortCode };
}

function createEventValues(
  body: z.infer<typeof eventCreateSchema>,
  userId: string,
): typeof events.$inferInsert {
  return {
    title: body.title,
    slug: body.slug,
    shortCode: body.shortCode,
    description: body.description ?? null,
    organizer: body.organizer,
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
    timezone: EVENT_TIME_ZONE,
    venue: body.venue ?? null,
    city: body.city ?? null,
    format: body.format,
    status: body.status,
    tags: body.tags,
    coverUrl: body.coverUrl ?? null,
    acceptUploadsFrom: new Date(body.acceptUploadsFrom),
    acceptUploadsUntil: new Date(body.acceptUploadsUntil),
    maxFileSizeBytes: body.maxFileSizeBytes,
    allowedMimeTypes: body.allowedMimeTypes,
    blockedExtensions: body.blockedExtensions,
    directAccessEnabled: body.directAccessEnabled,
    createdBy: userId,
    updatedBy: userId,
  };
}

function updateEventValues(
  body: z.infer<typeof eventUpdateSchema>,
  userId: string,
): Partial<typeof events.$inferInsert> {
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.slug === undefined ? {} : { slug: body.slug }),
    ...(body.shortCode === undefined ? {} : { shortCode: body.shortCode }),
    ...(body.description === undefined ? {} : { description: body.description ?? null }),
    ...(body.organizer === undefined ? {} : { organizer: body.organizer }),
    ...(body.startsAt === undefined ? {} : { startsAt: new Date(body.startsAt) }),
    ...(body.endsAt === undefined ? {} : { endsAt: new Date(body.endsAt) }),
    timezone: EVENT_TIME_ZONE,
    ...(body.venue === undefined ? {} : { venue: body.venue ?? null }),
    ...(body.city === undefined ? {} : { city: body.city ?? null }),
    ...(body.format === undefined ? {} : { format: body.format }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.coverUrl === undefined ? {} : { coverUrl: body.coverUrl ?? null }),
    ...(body.acceptUploadsFrom === undefined
      ? {}
      : { acceptUploadsFrom: new Date(body.acceptUploadsFrom) }),
    ...(body.acceptUploadsUntil === undefined
      ? {}
      : { acceptUploadsUntil: new Date(body.acceptUploadsUntil) }),
    ...(body.maxFileSizeBytes === undefined ? {} : { maxFileSizeBytes: body.maxFileSizeBytes }),
    ...(body.allowedMimeTypes === undefined ? {} : { allowedMimeTypes: body.allowedMimeTypes }),
    ...(body.blockedExtensions === undefined ? {} : { blockedExtensions: body.blockedExtensions }),
    ...(body.directAccessEnabled === undefined
      ? {}
      : { directAccessEnabled: body.directAccessEnabled }),
    updatedBy: userId,
  };
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const readGuards = [app.requireAuth, app.requireAdmin];
  const writeGuards = [app.requireAuth, app.requireCsrf, app.requireAdmin];

  app.get('/admin/dashboard', { preHandler: readGuards, schema: { tags: ['admin'] } }, async () => {
    const now = new Date();
    const staleUploadThreshold = new Date(now.getTime() - 60 * 60 * 1_000);
    const [
      [eventCount],
      [participantCount],
      [submissionCount],
      [artifactCount],
      [storage],
      latestUploads,
      [failedUploads],
    ] = await Promise.all([
      app.db
        .select({ value: count() })
        .from(events)
        .where(and(isNull(events.deletedAt), inArray(events.status, ['published', 'running']))),
      app.db.select({ value: countDistinct(eventParticipants.userId) }).from(eventParticipants),
      app.db.select({ value: count() }).from(submissions).where(isNull(submissions.deletedAt)),
      app.db.select({ value: count() }).from(artifacts).where(isNull(artifacts.deletedAt)),
      app.db
        .select({
          value: sum(sql`coalesce(${artifacts.actualSizeBytes}, ${artifacts.sizeBytes})`),
        })
        .from(artifacts)
        .where(eq(artifacts.status, 'ready')),
      app.db
        .select({ artifact: artifacts, user: users, event: events })
        .from(artifacts)
        .innerJoin(users, eq(users.id, artifacts.userId))
        .innerJoin(events, eq(events.id, artifacts.eventId))
        .orderBy(desc(artifacts.createdAt))
        .limit(10),
      app.db
        .select({ value: count() })
        .from(artifacts)
        .where(
          or(
            eq(artifacts.status, 'failed'),
            and(eq(artifacts.status, 'uploading'), lt(artifacts.createdAt, staleUploadThreshold)),
          ),
        ),
    ]);
    return {
      activeEvents: Number(eventCount?.value ?? 0),
      participants: Number(participantCount?.value ?? 0),
      submissions: Number(submissionCount?.value ?? 0),
      artifacts: Number(artifactCount?.value ?? 0),
      storageBytes: Number(storage?.value ?? 0),
      failedUploads: Number(failedUploads?.value ?? 0),
      latestUploads: latestUploads.map((row) => ({
        ...serializeArtifact(row.artifact),
        user: serializeUser(row.user),
        event: serializeEvent(row.event),
      })),
    };
  });

  app.get(
    '/admin/events',
    { preHandler: readGuards, schema: { tags: ['admin', 'events'] } },
    async (request) => {
      const query = paginationQuerySchema.parse(request.query);
      const conditions = [isNull(events.deletedAt)];
      if (query.q) {
        conditions.push(
          or(
            ilike(events.title, `%${query.q}%`),
            ilike(events.shortCode, `%${query.q}%`),
            ilike(events.organizer, `%${query.q}%`),
          )!,
        );
      }
      if (query.cursor) conditions.push(gt(events.id, query.cursor));
      const rows = await app.db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(desc(events.createdAt), asc(events.id))
        .limit(query.limit + 1);
      const page = parseCursorPagination(rows, query.limit);
      return { items: page.items.map(serializeEvent), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/admin/events/:eventId',
    { preHandler: readGuards, schema: { tags: ['admin', 'events'] } },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const [event] = await app.db
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
        .limit(1);
      if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
      return serializeEvent(event);
    },
  );

  app.post(
    '/admin/events',
    { preHandler: writeGuards, schema: { tags: ['admin', 'events'] } },
    async (request, reply) => {
      const submittedTitle = eventTitleSchema.parse(
        (request.body as { title?: unknown } | null)?.title,
      );
      const identifiers = await uniqueEventIdentifiers(app, submittedTitle);
      const body = eventCreateSchema.parse({
        ...(request.body as Record<string, unknown>),
        ...identifiers,
        timezone: EVENT_TIME_ZONE,
      });
      const [event] = await app.db
        .insert(events)
        .values(createEventValues(body, request.currentUser!.id))
        .returning();
      if (!event) throw new Error('Event insert returned no row');
      await writeAudit(request, {
        action: 'event.create',
        entityType: 'event',
        entityId: event.id,
        eventId: event.id,
      });
      return reply.code(201).send(serializeEvent(event));
    },
  );

  app.patch(
    '/admin/events/:eventId',
    { preHandler: writeGuards, schema: { tags: ['admin', 'events'] } },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const submittedBody = eventUpdateSchema.parse(request.body);
      const [currentEvent] = await app.db
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
        .limit(1);
      if (!currentEvent) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);

      validateEventDateRanges({
        startsAt: submittedBody.startsAt ? new Date(submittedBody.startsAt) : currentEvent.startsAt,
        endsAt: submittedBody.endsAt ? new Date(submittedBody.endsAt) : currentEvent.endsAt,
        acceptUploadsFrom: submittedBody.acceptUploadsFrom
          ? new Date(submittedBody.acceptUploadsFrom)
          : currentEvent.acceptUploadsFrom,
        acceptUploadsUntil: submittedBody.acceptUploadsUntil
          ? new Date(submittedBody.acceptUploadsUntil)
          : currentEvent.acceptUploadsUntil,
      });
      const identifiers = submittedBody.title
        ? await uniqueEventIdentifiers(app, submittedBody.title, eventId)
        : undefined;
      const normalizedBody = {
        ...submittedBody,
        slug: undefined,
        shortCode: undefined,
        ...identifiers,
        timezone: EVENT_TIME_ZONE,
      };
      const [event] = await app.db
        .update(events)
        .set(updateEventValues(normalizedBody, request.currentUser!.id))
        .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
        .returning();
      if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
      let invalidatedExports = 0;
      try {
        const exportInvalidation = await invalidateEventExports(
          app,
          event.id,
          'Недействительна после изменения мероприятия',
        );
        invalidatedExports = exportInvalidation.invalidatedExports;
      } catch (error) {
        app.log.warn({ error, eventId: event.id }, 'Export invalidation after event update failed');
      }
      await writeAudit(request, {
        action: 'event.update',
        entityType: 'event',
        entityId: event.id,
        eventId: event.id,
        metadata: {
          changedFields: Object.entries(normalizedBody)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key),
          invalidatedExports,
        },
      });
      return serializeEvent(event);
    },
  );

  app.delete(
    '/admin/events/:eventId',
    { preHandler: writeGuards, schema: { tags: ['admin', 'events'] } },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: string };
      const [event] = await app.db.select().from(events).where(eq(events.id, eventId)).limit(1);
      if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
      const deletedAt = event.deletedAt ?? new Date();

      await app.db.transaction(async (transaction) => {
        await transaction
          .update(events)
          .set({
            status: 'archived',
            directAccessEnabled: false,
            updatedBy: request.currentUser!.id,
          })
          .where(eq(events.id, eventId));
        await transaction
          .update(submissions)
          .set({ status: 'deleted', deletedAt })
          .where(eq(submissions.eventId, eventId));
        await transaction
          .update(artifacts)
          .set({
            status: 'deleted',
            statusReason: 'Удалено вместе с мероприятием',
            deletedAt,
          })
          .where(eq(artifacts.eventId, eventId));
        await transaction
          .update(exportJobs)
          .set({
            status: 'expired',
            expiresAt: deletedAt,
            errorMessage: 'Удалено вместе с мероприятием',
          })
          .where(eq(exportJobs.eventId, eventId));
      });

      let purgeResult;
      try {
        purgeResult = await purgeEventStorage(
          app.s3Internal,
          [
            app.config.S3_QUARANTINE_BUCKET,
            app.config.S3_PRIVATE_BUCKET,
            app.config.S3_EXPORT_BUCKET,
          ],
          eventId,
        );
      } catch (error) {
        app.log.error({ error, eventId }, 'Event storage purge failed');
        throw new AppError(
          'EVENT_STORAGE_DELETE_FAILED',
          'Не удалось полностью очистить файлы мероприятия. Повторите удаление.',
          502,
        );
      }

      await app.db.transaction(async (transaction) => {
        await transaction
          .update(artifacts)
          .set({ uploadId: null, storageDeletedAt: new Date() })
          .where(eq(artifacts.eventId, eventId));
        await transaction
          .update(exportJobs)
          .set({ bucket: null, objectKey: null, sizeBytes: null })
          .where(eq(exportJobs.eventId, eventId));
        await transaction
          .update(events)
          .set({ deletedAt, updatedAt: new Date() })
          .where(eq(events.id, eventId));
      });

      await writeAudit(request, {
        action: 'event.delete',
        entityType: 'event',
        entityId: event.id,
        eventId: event.id,
        metadata: { ...purgeResult },
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/admin/users',
    { preHandler: readGuards, schema: { tags: ['admin', 'users'] } },
    async (request) => {
      const query = participantQuerySchema.parse(request.query);
      const conditions = [];
      if (query.eventId) conditions.push(eq(eventParticipants.eventId, query.eventId));
      if (query.cursor) conditions.push(gt(users.id, query.cursor));
      if (query.q) {
        conditions.push(
          or(
            ilike(users.fullName, `%${query.q}%`),
            ilike(users.telegramUsername, `%${query.q}%`),
            ilike(users.organization, `%${query.q}%`),
          )!,
        );
      }
      const rows = await app.db
        .select({
          user: users,
          joinedAt: sql<Date | null>`min(${eventParticipants.joinedAt})`,
          lastSubmissionAt: sql<Date | null>`max(${eventParticipants.lastSubmissionAt})`,
          submissionCount: countDistinct(submissions.id),
          artifactCount: countDistinct(artifacts.id),
          totalBytes: sql<number>`coalesce(sum(distinct ${artifacts.sizeBytes}), 0)`,
        })
        .from(users)
        .leftJoin(eventParticipants, eq(eventParticipants.userId, users.id))
        .leftJoin(
          submissions,
          and(
            eq(submissions.userId, users.id),
            query.eventId ? eq(submissions.eventId, query.eventId) : sql`true`,
            isNull(submissions.deletedAt),
          ),
        )
        .leftJoin(
          artifacts,
          and(
            eq(artifacts.userId, users.id),
            query.eventId ? eq(artifacts.eventId, query.eventId) : sql`true`,
            isNull(artifacts.deletedAt),
          ),
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(users.id)
        .orderBy(asc(users.id))
        .limit(query.limit + 1);
      const page = parseCursorPagination(
        rows.map((row) => ({
          ...serializeUser(row.user),
          joinedAt: row.joinedAt,
          lastSubmissionAt: row.lastSubmissionAt,
          submissionCount: Number(row.submissionCount),
          artifactCount: Number(row.artifactCount),
          totalBytes: Number(row.totalBytes),
        })),
        query.limit,
      );
      return page;
    },
  );

  app.delete(
    '/admin/events/:eventId/participants/:userId',
    { preHandler: writeGuards, schema: { tags: ['admin', 'users', 'events'] } },
    async (request) => {
      const { eventId, userId } = eventParticipantParamsSchema.parse(request.params);
      const [event] = await app.db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
        .limit(1);
      if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);

      const removedAt = new Date();
      const removal = await app.db.transaction(async (transaction) => {
        const [participant] = await transaction
          .select({ userId: eventParticipants.userId })
          .from(eventParticipants)
          .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, userId)))
          .limit(1);
        if (!participant) {
          throw new AppError(
            'EVENT_PARTICIPANT_NOT_FOUND',
            'Участник не найден в мероприятии',
            404,
          );
        }
        const deletedSubmissions = await transaction
          .update(submissions)
          .set({ status: 'deleted', deletedAt: removedAt, updatedAt: removedAt })
          .where(
            and(
              eq(submissions.eventId, eventId),
              eq(submissions.userId, userId),
              isNull(submissions.deletedAt),
            ),
          )
          .returning({ id: submissions.id });
        const deletedArtifacts = await transaction
          .update(artifacts)
          .set({
            status: 'deleted',
            statusReason: 'Удалено администратором вместе с участником',
            deletedAt: removedAt,
            updatedAt: removedAt,
          })
          .where(
            and(
              eq(artifacts.eventId, eventId),
              eq(artifacts.userId, userId),
              isNull(artifacts.deletedAt),
            ),
          )
          .returning({ id: artifacts.id });
        const storedArtifacts = await transaction
          .select({
            id: artifacts.id,
            bucket: artifacts.bucket,
            objectKey: artifacts.objectKey,
            uploadId: artifacts.uploadId,
          })
          .from(artifacts)
          .where(and(eq(artifacts.eventId, eventId), eq(artifacts.userId, userId)));
        const invalidatedExports = await transaction
          .update(exportJobs)
          .set({
            status: 'expired',
            expiresAt: removedAt,
            errorMessage: 'Недействительна после удаления участника',
          })
          .where(
            and(
              eq(exportJobs.eventId, eventId),
              inArray(exportJobs.status, ['queued', 'processing', 'ready', 'failed']),
            ),
          )
          .returning({ id: exportJobs.id });
        const storedExports = await transaction
          .select({
            id: exportJobs.id,
            kind: exportJobs.kind,
            bucket: exportJobs.bucket,
            objectKey: exportJobs.objectKey,
          })
          .from(exportJobs)
          .where(eq(exportJobs.eventId, eventId));

        return {
          deletedSubmissions,
          deletedArtifacts,
          storedArtifacts,
          invalidatedExports,
          storedExports,
        };
      });

      const storageTargets: StoredObjectTarget[] = [];
      for (const artifact of removal.storedArtifacts) {
        for (const bucket of new Set([
          artifact.bucket,
          app.config.S3_QUARANTINE_BUCKET,
          app.config.S3_PRIVATE_BUCKET,
        ])) {
          storageTargets.push({
            bucket,
            key: artifact.objectKey,
            uploadId: bucket === artifact.bucket ? artifact.uploadId : null,
          });
        }
      }
      for (const job of removal.storedExports) {
        const generatedKey = `${eventId}/${job.id}.${job.kind}`;
        storageTargets.push({
          bucket: app.config.S3_EXPORT_BUCKET,
          key: generatedKey,
        });
        if (job.bucket && job.objectKey) {
          storageTargets.push({ bucket: job.bucket, key: job.objectKey });
        }
      }

      let purgeResult;
      try {
        purgeResult = await purgeStoredObjects(app.s3Internal, storageTargets);
      } catch (error) {
        app.log.error({ error, eventId, userId }, 'Participant storage purge failed');
        throw new AppError(
          'PARTICIPANT_STORAGE_DELETE_FAILED',
          'Не удалось полностью удалить файлы участника. Повторите удаление.',
          502,
        );
      }

      await app.db.transaction(async (transaction) => {
        if (removal.storedArtifacts.length > 0) {
          await transaction
            .update(artifacts)
            .set({ uploadId: null, storageDeletedAt: new Date() })
            .where(
              inArray(
                artifacts.id,
                removal.storedArtifacts.map((artifact) => artifact.id),
              ),
            );
        }
        if (removal.storedExports.length > 0) {
          await transaction
            .update(exportJobs)
            .set({ bucket: null, objectKey: null, sizeBytes: null })
            .where(
              inArray(
                exportJobs.id,
                removal.storedExports.map((job) => job.id),
              ),
            );
        }
        await transaction
          .delete(eventParticipants)
          .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, userId)));
      });

      const result = {
        participantRemoved: true,
        submissionsDeleted: removal.deletedSubmissions.length,
        artifactsDeleted: removal.deletedArtifacts.length,
        exportsInvalidated: removal.invalidatedExports.length,
        ...purgeResult,
      };
      await writeAudit(request, {
        action: 'event.participant.delete',
        entityType: 'event_participant',
        entityId: userId,
        eventId,
        metadata: result,
      });
      return result;
    },
  );

  app.get(
    '/admin/submissions',
    { preHandler: readGuards, schema: { tags: ['admin', 'submissions'] } },
    async (request) => {
      const query = participantQuerySchema.parse(request.query);
      const conditions = [isNull(submissions.deletedAt)];
      if (query.eventId) conditions.push(eq(submissions.eventId, query.eventId));
      if (query.cursor) conditions.push(gt(submissions.id, query.cursor));
      if (query.q) {
        conditions.push(
          or(
            ilike(submissions.title, `%${query.q}%`),
            ilike(submissions.text, `%${query.q}%`),
            ilike(users.fullName, `%${query.q}%`),
          )!,
        );
      }
      const rows = await app.db
        .select({
          submission: submissions,
          user: users,
          event: events,
          artifactCount: count(artifacts.id),
        })
        .from(submissions)
        .innerJoin(users, eq(users.id, submissions.userId))
        .innerJoin(events, eq(events.id, submissions.eventId))
        .leftJoin(
          artifacts,
          and(eq(artifacts.submissionId, submissions.id), isNull(artifacts.deletedAt)),
        )
        .where(and(...conditions))
        .groupBy(submissions.id, users.id, events.id)
        .orderBy(desc(submissions.createdAt), asc(submissions.id))
        .limit(query.limit + 1);
      const page = parseCursorPagination(
        rows.map((row) => ({
          ...serializeSubmission(row.submission),
          user: serializeUser(row.user),
          event: serializeEvent(row.event),
          artifactCount: Number(row.artifactCount),
        })),
        query.limit,
      );
      return page;
    },
  );

  app.get(
    '/admin/artifacts',
    { preHandler: readGuards, schema: { tags: ['admin', 'artifacts'] } },
    async (request) => {
      const query = artifactQuerySchema.parse(request.query);
      const conditions = [isNull(artifacts.deletedAt)];
      if (query.eventId) conditions.push(eq(artifacts.eventId, query.eventId));
      if (query.status) conditions.push(eq(artifacts.status, query.status));
      if (query.cursor) conditions.push(gt(artifacts.id, query.cursor));
      if (query.q) {
        conditions.push(
          or(
            ilike(artifacts.originalName, `%${query.q}%`),
            ilike(users.fullName, `%${query.q}%`),
            ilike(events.title, `%${query.q}%`),
          )!,
        );
      }
      const rows = await app.db
        .select({ artifact: artifacts, user: users, event: events })
        .from(artifacts)
        .innerJoin(users, eq(users.id, artifacts.userId))
        .innerJoin(events, eq(events.id, artifacts.eventId))
        .where(and(...conditions))
        .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
        .limit(query.limit + 1);
      const page = parseCursorPagination(
        rows.map((row) => ({
          ...serializeArtifact(row.artifact),
          user: serializeUser(row.user),
          event: serializeEvent(row.event),
        })),
        query.limit,
      );
      return page;
    },
  );

  app.patch(
    '/admin/artifacts/:artifactId',
    { preHandler: writeGuards, schema: { tags: ['admin', 'artifacts'] } },
    async (request) => {
      const { artifactId } = request.params as { artifactId: string };
      const body = statusUpdateSchema.parse(request.body);
      const [currentArtifact] = await app.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .limit(1);
      if (!currentArtifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Файл не найден', 404);
      if (
        body.status !== 'deleted' &&
        (currentArtifact.deletedAt || currentArtifact.storageDeletedAt)
      ) {
        throw new AppError(
          'ARTIFACT_STORAGE_DELETED',
          'Файл уже удалён из хранилища и не может быть восстановлен',
          409,
        );
      }
      const [artifact] = await app.db
        .update(artifacts)
        .set({
          status: body.status,
          statusReason: body.reason ?? null,
          readyAt: body.status === 'ready' ? new Date() : null,
          deletedAt: body.status === 'deleted' ? new Date() : null,
        })
        .where(eq(artifacts.id, artifactId))
        .returning();
      if (!artifact) throw new Error('Artifact disappeared during status update');
      if (body.status === 'deleted') {
        try {
          await deleteArtifactObjects(app, [artifact]);
        } catch (error) {
          app.log.warn({ error, artifactId }, 'Admin artifact storage cleanup deferred');
        }
      }
      try {
        await invalidateEventExports(
          app,
          artifact.eventId,
          'Недействительна после изменения статуса файла',
        );
      } catch (error) {
        app.log.warn(
          { error, eventId: artifact.eventId },
          'Export invalidation after admin artifact status change failed',
        );
      }
      await writeAudit(request, {
        action: 'artifact.status.change',
        entityType: 'artifact',
        entityId: artifact.id,
        eventId: artifact.eventId,
        metadata: { status: body.status, reason: body.reason ?? null },
      });
      return serializeArtifact(artifact);
    },
  );

  app.get(
    '/admin/audit',
    { preHandler: readGuards, schema: { tags: ['admin', 'audit'] } },
    async (request) => {
      const query = paginationQuerySchema.parse(request.query);
      const conditions = [];
      if (query.q) {
        conditions.push(
          or(
            ilike(auditLogs.action, `%${query.q}%`),
            ilike(auditLogs.entityType, `%${query.q}%`),
            ilike(auditLogs.entityId, `%${query.q}%`),
          )!,
        );
      }
      const rows = await app.db
        .select()
        .from(auditLogs)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(auditLogs.createdAt))
        .limit(query.limit);
      return { items: rows, nextCursor: null };
    },
  );
};
