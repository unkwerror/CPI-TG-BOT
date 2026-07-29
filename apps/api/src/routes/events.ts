import type { FastifyPluginAsync } from 'fastify';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { artifacts, eventParticipants, events, submissions } from '@cpi/db';
import {
  AppError,
  eventAcceptsUploads,
  eventListQuerySchema,
  parseCursorPagination,
  submissionCreateSchema,
} from '@cpi/shared';
import { serializeArtifact, serializeEvent, serializeSubmission } from '../serializers';

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/events',
    { preHandler: app.requireAuth, schema: { tags: ['events'] } },
    async (request) => {
      const query = eventListQuerySchema.parse(request.query);
      const conditions = [
        isNull(events.deletedAt),
        inArray(events.status, ['published', 'running', 'finished']),
      ];
      if (query.q) {
        const pattern = `%${query.q}%`;
        conditions.push(sql<boolean>`${events.searchText} ILIKE ${pattern}`);
      }
      if (query.city) conditions.push(eq(events.city, query.city));
      if (query.format) conditions.push(eq(events.format, query.format));
      if (query.status && ['published', 'running', 'finished'].includes(query.status)) {
        conditions.push(eq(events.status, query.status));
      }
      if (query.dateFrom) conditions.push(gte(events.startsAt, new Date(query.dateFrom)));
      if (query.dateTo) conditions.push(lte(events.startsAt, new Date(query.dateTo)));
      if (query.cursor) conditions.push(gt(events.id, query.cursor));

      const rows = await app.db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(asc(events.startsAt), asc(events.id))
        .limit(query.limit + 1);
      const page = parseCursorPagination(rows, query.limit);
      return {
        items: page.items.map(serializeEvent),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/events/:eventKey',
    { preHandler: app.requireAuth, schema: { tags: ['events'] } },
    async (request, reply) => {
      const { eventKey } = request.params as { eventKey: string };
      const [event] = await app.db
        .select()
        .from(events)
        .where(
          and(
            or(
              eq(events.id, eventKey),
              eq(events.slug, eventKey.toLowerCase()),
              eq(events.shortCode, eventKey.toUpperCase()),
            ),
            isNull(events.deletedAt),
            inArray(events.status, ['published', 'running', 'finished']),
          ),
        )
        .limit(1);
      if (!event || (!event.directAccessEnabled && event.id !== eventKey)) {
        return reply
          .code(404)
          .send({ error: { code: 'EVENT_NOT_FOUND', message: 'Мероприятие не найдено' } });
      }
      await app.db
        .insert(eventParticipants)
        .values({
          eventId: event.id,
          userId: request.currentUser!.id,
          source: 'opened',
        })
        .onConflictDoNothing();
      return serializeEvent(event);
    },
  );

  app.get(
    '/events/:eventId/submissions',
    { preHandler: app.requireAuth, schema: { tags: ['submissions'] } },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const rows = await app.db
        .select({
          submission: submissions,
          artifactCount: sql<number>`count(${artifacts.id})::int`,
        })
        .from(submissions)
        .leftJoin(
          artifacts,
          and(eq(artifacts.submissionId, submissions.id), isNull(artifacts.deletedAt)),
        )
        .where(
          and(
            eq(submissions.eventId, eventId),
            eq(submissions.userId, request.currentUser!.id),
            isNull(submissions.deletedAt),
          ),
        )
        .groupBy(submissions.id)
        .orderBy(desc(submissions.createdAt))
        .limit(100);
      return {
        items: rows.map((row) => ({
          ...serializeSubmission(row.submission),
          artifactCount: row.artifactCount,
        })),
      };
    },
  );

  app.post(
    '/events/:eventId/submissions',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['submissions'] },
    },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: string };
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REQUIRED',
          'Передайте уникальный заголовок Idempotency-Key',
          400,
        );
      }
      const body = submissionCreateSchema.parse(request.body);
      if (!request.currentUser!.fullName || !request.currentUser!.consentAt) {
        throw new AppError(
          'PROFILE_INCOMPLETE',
          'Перед отправкой заполните профиль и подтвердите согласие',
          409,
        );
      }

      const [event] = await app.db
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
        .limit(1);
      if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
      if (!eventAcceptsUploads(event)) {
        throw new AppError('EVENT_UPLOADS_CLOSED', 'Приём материалов сейчас закрыт', 409);
      }

      const result = await app.db.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(submissions)
          .values({
            eventId,
            userId: request.currentUser!.id,
            title: body.title ?? null,
            text: body.text ?? null,
            link: body.link ?? null,
            status: body.hasFiles ? 'draft' : 'ready',
            idempotencyKey,
            submittedAt: body.hasFiles ? null : new Date(),
          })
          .onConflictDoUpdate({
            target: [submissions.userId, submissions.idempotencyKey],
            set: { updatedAt: new Date() },
          })
          .returning();
        if (!created) throw new Error('Submission insert returned no row');
        await transaction
          .insert(eventParticipants)
          .values({
            eventId,
            userId: request.currentUser!.id,
            source: 'submitted',
            lastSubmissionAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [eventParticipants.eventId, eventParticipants.userId],
            set: { lastSubmissionAt: new Date() },
          });
        return created;
      });
      return reply.code(201).send(serializeSubmission(result));
    },
  );

  app.delete(
    '/events/:eventId/submissions/:submissionId',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['submissions'] },
    },
    async (request, reply) => {
      const { eventId, submissionId } = request.params as {
        eventId: string;
        submissionId: string;
      };
      const [event] = await app.db.select().from(events).where(eq(events.id, eventId)).limit(1);
      if (!event || !eventAcceptsUploads(event)) {
        throw new AppError('EVENT_UPLOADS_CLOSED', 'Удаление после закрытия приёма запрещено', 409);
      }
      const [updated] = await app.db
        .update(submissions)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(
          and(
            eq(submissions.id, submissionId),
            eq(submissions.eventId, eventId),
            eq(submissions.userId, request.currentUser!.id),
            isNull(submissions.deletedAt),
          ),
        )
        .returning();
      if (!updated) throw new AppError('SUBMISSION_NOT_FOUND', 'Отправка не найдена', 404);
      await app.db
        .update(artifacts)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(
          and(
            eq(artifacts.submissionId, submissionId),
            eq(artifacts.userId, request.currentUser!.id),
            isNull(artifacts.deletedAt),
          ),
        );
      return reply.code(204).send();
    },
  );

  app.get(
    '/events/:eventId/submissions/:submissionId',
    { preHandler: app.requireAuth, schema: { tags: ['submissions'] } },
    async (request) => {
      const { eventId, submissionId } = request.params as {
        eventId: string;
        submissionId: string;
      };
      const [submission] = await app.db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.id, submissionId),
            eq(submissions.eventId, eventId),
            eq(submissions.userId, request.currentUser!.id),
            isNull(submissions.deletedAt),
          ),
        )
        .limit(1);
      if (!submission) throw new AppError('SUBMISSION_NOT_FOUND', 'Отправка не найдена', 404);
      const files = await app.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.submissionId, submissionId), isNull(artifacts.deletedAt)))
        .orderBy(artifacts.createdAt);
      return { ...serializeSubmission(submission), artifacts: files.map(serializeArtifact) };
    },
  );
};
