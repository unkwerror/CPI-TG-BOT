import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { artifacts, events, submissions, users } from '@cpi/db';
import { profileUpdateSchema } from '@cpi/shared';
import { serializeArtifact, serializeEvent, serializeSubmission } from '../serializers';

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/me',
    { preHandler: app.requireAuth, schema: { tags: ['profile'] } },
    async (request) => {
      const user = request.currentUser!;
      return {
        id: user.id,
        telegramUserId: user.telegramUserId.toString(),
        telegramUsername: user.telegramUsername,
        fullName: user.fullName,
        organization: user.organization,
        position: user.position,
        phone: user.phone,
        consentAt: user.consentAt,
        status: user.status,
        roles: user.roles,
        profileComplete: Boolean(user.fullName && user.consentAt),
      };
    },
  );

  app.patch(
    '/me',
    { preHandler: [app.requireAuth, app.requireCsrf], schema: { tags: ['profile'] } },
    async (request) => {
      const body = profileUpdateSchema.parse(request.body);
      const [updated] = await app.db
        .update(users)
        .set({
          fullName: body.fullName,
          organization: body.organization ?? null,
          position: body.position ?? null,
          phone: body.phone ?? null,
          consentAt: request.currentUser!.consentAt ?? new Date(),
          lastSeenAt: new Date(),
        })
        .where(eq(users.id, request.currentUser!.id))
        .returning();
      return {
        ...updated,
        telegramUserId: updated?.telegramUserId.toString(),
        profileComplete: true,
      };
    },
  );

  app.get(
    '/me/submissions',
    { preHandler: app.requireAuth, schema: { tags: ['submissions'] } },
    async (request) => {
      const rows = await app.db
        .select({
          submission: submissions,
          event: events,
          artifactCount: sql<number>`count(${artifacts.id})::int`,
        })
        .from(submissions)
        .innerJoin(events, eq(events.id, submissions.eventId))
        .leftJoin(
          artifacts,
          and(eq(artifacts.submissionId, submissions.id), isNull(artifacts.deletedAt)),
        )
        .where(and(eq(submissions.userId, request.currentUser!.id), isNull(submissions.deletedAt)))
        .groupBy(submissions.id, events.id)
        .orderBy(desc(submissions.createdAt))
        .limit(100);
      return {
        items: rows.map((row) => ({
          ...serializeSubmission(row.submission),
          event: serializeEvent(row.event),
          artifactCount: row.artifactCount,
        })),
      };
    },
  );

  app.get(
    '/me/submissions/:submissionId',
    { preHandler: app.requireAuth, schema: { tags: ['submissions'] } },
    async (request, reply) => {
      const { submissionId } = request.params as { submissionId: string };
      const [submission] = await app.db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.id, submissionId),
            eq(submissions.userId, request.currentUser!.id),
            isNull(submissions.deletedAt),
          ),
        )
        .limit(1);
      if (!submission) {
        return reply
          .code(404)
          .send({ error: { code: 'SUBMISSION_NOT_FOUND', message: 'Отправка не найдена' } });
      }
      const files = await app.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.submissionId, submission.id), isNull(artifacts.deletedAt)))
        .orderBy(artifacts.createdAt);
      return {
        ...serializeSubmission(submission),
        artifacts: files.map(serializeArtifact),
      };
    },
  );
};
