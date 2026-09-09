import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eventParticipants, eventQuickAnswers, events, outboxEvents } from '@cpi/db';
import { AppError, eventAcceptsUploads, isCrmReadyFullName, quickAnswerSchema } from '@cpi/shared';
import { invalidateEventExports } from '../export-storage';

export const quickAnswerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/:eventId/quick-answer', { preHandler: app.requireAuth }, async (request) => {
    const { eventId } = z.object({ eventId: z.uuid() }).parse(request.params);
    const [event] = await app.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.id, eventId),
          isNull(events.deletedAt),
          inArray(events.status, ['published', 'running', 'finished']),
        ),
      )
      .limit(1);
    if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
    const [answer] = await app.db
      .select()
      .from(eventQuickAnswers)
      .where(
        and(
          eq(eventQuickAnswers.eventId, eventId),
          eq(eventQuickAnswers.userId, request.currentUser!.id),
        ),
      )
      .limit(1);
    return { answer: answer ?? null };
  });

  app.post(
    '/events/:eventId/quick-answer',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
    },
    async (request, reply) => {
      const { eventId } = z.object({ eventId: z.uuid() }).parse(request.params);
      const body = quickAnswerSchema.parse(request.body);
      const user = request.currentUser!;
      const result = await app.db.transaction(async (transaction) => {
        const [event] = await transaction
          .select()
          .from(events)
          .where(
            and(
              eq(events.id, eventId),
              isNull(events.deletedAt),
              inArray(events.status, ['published', 'running', 'finished']),
            ),
          )
          .limit(1)
          .for('share');
        if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
        const ownAnswer = and(
          eq(eventQuickAnswers.eventId, eventId),
          eq(eventQuickAnswers.userId, user.id),
        );
        const [existing] = await transaction
          .select()
          .from(eventQuickAnswers)
          .where(ownAnswer)
          .limit(1);
        const replay = (answer: typeof eventQuickAnswers.$inferSelect) => {
          if (answer.answer !== body.answer) {
            throw new AppError(
              'QUICK_ANSWER_ALREADY_SUBMITTED',
              'Вы уже ответили на быстрый вопрос. Изменить ответ нельзя.',
              409,
            );
          }
          return { answer, created: false };
        };
        if (existing) return replay(existing);
        if (!isCrmReadyFullName(user.fullName) || !user.consentAt) {
          throw new AppError(
            'PROFILE_INCOMPLETE',
            'Перед отправкой заполните ФИО и подтвердите согласие в профиле',
            409,
          );
        }
        if (!eventAcceptsUploads(event)) {
          throw new AppError('EVENT_UPLOADS_CLOSED', 'Приём ответов сейчас закрыт', 409);
        }
        const [answer] = await transaction
          .insert(eventQuickAnswers)
          .values({
            eventId,
            userId: user.id,
            fullName: user.fullName!,
            answer: body.answer,
          })
          .onConflictDoNothing()
          .returning();
        if (!answer) {
          const [concurrent] = await transaction
            .select()
            .from(eventQuickAnswers)
            .where(ownAnswer)
            .limit(1);
          if (!concurrent) throw new Error('Quick answer disappeared after conflict');
          return replay(concurrent);
        }
        const [joined] = await transaction
          .insert(eventParticipants)
          .values({
            eventId,
            userId: user.id,
            source: 'quick_answer',
          })
          .onConflictDoNothing()
          .returning();
        if (joined) {
          await transaction
            .insert(outboxEvents)
            .values({
              type: 'crm.participation.sync',
              aggregateType: 'event_participation',
              aggregateId: `${eventId}:${user.id}`,
              payload: { eventId, userId: user.id },
            })
            .onConflictDoUpdate({
              target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
              set: { processedAt: null, availableAt: new Date(), attempts: 0, lastError: null },
            });
        }
        return { answer, created: true };
      });
      if (result.created) {
        try {
          await invalidateEventExports(app, eventId, 'Добавлен ответ на быстрый вопрос');
        } catch (error) {
          app.log.warn({ error, eventId }, 'Quick answer export invalidation failed');
        }
      }
      return reply.code(result.created ? 201 : 200).send({ answer: result.answer });
    },
  );
};
