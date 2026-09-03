import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  eventParticipants,
  eventRequests,
  events,
  outboxEvents,
  submissions,
  users,
} from '@cpi/db';
import { AppError } from '@cpi/shared';
import { writeAudit } from '../audit';
import { invalidateEventExports } from '../export-storage';

const requestCreateSchema = z.object({
  text: z.string().trim().min(5).max(10_000),
});
const eventParams = z.object({ eventId: z.uuid() });
const requestParams = z.object({ id: z.uuid() });
const adminQuerySchema = z.object({
  eventId: z.uuid().optional(),
  status: z.enum(['new', 'in_progress', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const requestUpdateSchema = z.object({
  status: z.enum(['new', 'in_progress', 'closed']),
  assignedTo: z.uuid().nullable().optional(),
});

export const eventRequestRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/events/:eventId/requests/me',
    { preHandler: app.requireAuth, schema: { tags: ['events'] } },
    async (request) => {
      const { eventId } = eventParams.parse(request.params);
      const rows = await app.db
        .select()
        .from(eventRequests)
        .where(
          and(
            eq(eventRequests.eventId, eventId),
            eq(eventRequests.userId, request.currentUser!.id),
          ),
        )
        .orderBy(desc(eventRequests.createdAt))
        .limit(50);
      return { items: rows };
    },
  );

  app.post(
    '/events/:eventId/requests',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['events'] },
    },
    async (request, reply) => {
      const { eventId } = eventParams.parse(request.params);
      const body = requestCreateSchema.parse(request.body);
      const [event] = await app.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.id, eventId),
            isNull(events.deletedAt),
            inArray(events.status, ['published', 'running']),
          ),
        )
        .limit(1);
      if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
      if (!event.acceptsRequests) {
        throw new AppError('EVENT_REQUESTS_DISABLED', 'Обращения для мероприятия закрыты', 409);
      }
      const created = await app.db.transaction(async (transaction) => {
        const [open] = await transaction
          .select()
          .from(eventRequests)
          .where(
            and(
              eq(eventRequests.eventId, event.id),
              eq(eventRequests.userId, request.currentUser!.id),
              inArray(eventRequests.status, ['new', 'in_progress']),
            ),
          )
          .limit(1);
        if (open) {
          throw new AppError(
            'EVENT_REQUEST_ALREADY_OPEN',
            'У вас уже есть открытое обращение по этому мероприятию',
            409,
          );
        }
        const [row] = await transaction
          .insert(eventRequests)
          .values({
            eventId: event.id,
            userId: request.currentUser!.id,
            text: body.text,
            attachments: [],
          })
          .returning();
        if (!row) throw new Error('Event request insert returned no row');
        const submittedAt = row.createdAt;
        await transaction
          .insert(eventParticipants)
          .values({
            eventId: event.id,
            userId: request.currentUser!.id,
            source: 'request',
            lastSubmissionAt: submittedAt,
          })
          .onConflictDoUpdate({
            target: [eventParticipants.eventId, eventParticipants.userId],
            set: { lastSubmissionAt: submittedAt },
          });
        await transaction.insert(submissions).values({
          id: row.id,
          eventId: event.id,
          userId: request.currentUser!.id,
          title: `Вопрос по мероприятию: ${event.title}`,
          text: body.text,
          sourceKind: 'event_request',
          status: 'ready',
          idempotencyKey: `event-request:${row.id}`,
          createdAt: submittedAt,
          updatedAt: submittedAt,
          submittedAt,
        });
        await transaction
          .insert(outboxEvents)
          .values([
            {
              type: 'crm.participation.sync',
              aggregateType: 'event_participation',
              aggregateId: `${event.id}:${request.currentUser!.id}`,
              payload: { eventId: event.id, userId: request.currentUser!.id },
            },
            {
              type: 'crm.submission.sync',
              aggregateType: 'submission',
              aggregateId: row.id,
              payload: { submissionId: row.id },
            },
          ])
          .onConflictDoNothing();
        return row;
      });
      try {
        await invalidateEventExports(app, event.id, 'Недействительна после добавления обращения');
      } catch (error) {
        app.log.warn(
          { error, eventId: event.id, requestId: created.id },
          'Export invalidation after event request creation failed',
        );
      }
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/admin/event-requests',
    {
      preHandler: [app.requireAuth, app.requireAdmin],
      schema: { tags: ['admin', 'events'] },
    },
    async (request) => {
      const query = adminQuerySchema.parse(request.query);
      const conditions = [];
      if (query.eventId) conditions.push(eq(eventRequests.eventId, query.eventId));
      if (query.status) conditions.push(eq(eventRequests.status, query.status));
      const rows = await app.db
        .select({
          request: eventRequests,
          event: events,
          user: users,
          submission: submissions,
        })
        .from(eventRequests)
        .innerJoin(events, eq(events.id, eventRequests.eventId))
        .innerJoin(users, eq(users.id, eventRequests.userId))
        .leftJoin(submissions, eq(submissions.id, eventRequests.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(eventRequests.createdAt), asc(eventRequests.id))
        .limit(query.limit);
      return {
        items: rows.map((row) => ({
          ...row.request,
          event: { id: row.event.id, title: row.event.title },
          user: {
            id: row.user.id,
            fullName: row.user.fullName,
            username: row.user.telegramUsername,
            firstName: row.user.telegramFirstName,
            lastName: row.user.telegramLastName,
          },
          crm: row.submission
            ? {
                artifactId: row.submission.crmArtifactId,
                artifactVersionId: row.submission.crmArtifactVersionId,
                taskId: row.submission.crmTaskId,
                syncedAt: row.submission.crmSyncedAt,
                pendingReviewAt: row.submission.crmPendingReviewAt,
                error: row.submission.crmSyncError,
              }
            : null,
        })),
      };
    },
  );

  app.patch(
    '/admin/event-requests/:id',
    {
      preHandler: [app.requireAuth, app.requireCsrf, app.requireAdmin],
      schema: { tags: ['admin', 'events'] },
    },
    async (request) => {
      const { id } = requestParams.parse(request.params);
      const body = requestUpdateSchema.parse(request.body);
      if (body.assignedTo) {
        const [assignee] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, body.assignedTo))
          .limit(1);
        if (!assignee) throw new AppError('USER_NOT_FOUND', 'Ответственный не найден', 404);
      }
      const [updated] = await app.db
        .update(eventRequests)
        .set({
          status: body.status,
          ...(body.assignedTo === undefined ? {} : { assignedTo: body.assignedTo }),
          closedAt: body.status === 'closed' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(eventRequests.id, id))
        .returning();
      if (!updated) throw new AppError('EVENT_REQUEST_NOT_FOUND', 'Обращение не найдено', 404);
      await writeAudit(request, {
        action: 'event_request.update',
        entityType: 'event_request',
        entityId: updated.id,
        eventId: updated.eventId,
        metadata: { status: updated.status, assignedTo: updated.assignedTo },
      });
      return updated;
    },
  );

  app.post(
    '/admin/event-requests/:id/retry-crm',
    {
      preHandler: [app.requireAuth, app.requireCsrf, app.requireAdmin],
      schema: { tags: ['admin', 'events'] },
    },
    async (request) => {
      const { id } = requestParams.parse(request.params);
      await app.db.transaction(async (transaction) => {
        const [record] = await transaction
          .select({ requestId: eventRequests.id, submissionId: submissions.id })
          .from(eventRequests)
          .leftJoin(submissions, eq(submissions.id, eventRequests.id))
          .where(eq(eventRequests.id, id))
          .limit(1);
        if (!record) {
          throw new AppError('EVENT_REQUEST_NOT_FOUND', 'Обращение не найдено', 404);
        }
        if (!record.submissionId) {
          throw new AppError(
            'EVENT_REQUEST_ARTIFACT_NOT_FOUND',
            'Для обращения не создан текстовый артефакт',
            409,
          );
        }
        await transaction
          .update(submissions)
          .set({
            crmPendingReviewAt: null,
            crmSyncError: null,
            crmSyncFailedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(submissions.id, record.submissionId));
        await transaction
          .insert(outboxEvents)
          .values({
            type: 'crm.submission.sync',
            aggregateType: 'submission',
            aggregateId: record.submissionId,
            payload: { submissionId: record.submissionId },
          })
          .onConflictDoUpdate({
            target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
            set: {
              attempts: 0,
              availableAt: new Date(),
              processedAt: null,
              lastError: null,
              payload: { submissionId: record.submissionId },
            },
          });
      });
      await writeAudit(request, {
        action: 'event_request.crm_retry',
        entityType: 'event_request',
        entityId: id,
      });
      return { id, queued: true };
    },
  );
};
