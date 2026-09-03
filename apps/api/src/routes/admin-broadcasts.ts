import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { events, feedPosts, storeProducts, users } from '@cpi/db';
import { AppError } from '@cpi/shared';
import { writeAudit } from '../audit';
import {
  enqueueManualContentBroadcast,
  type ManualContentBroadcastTarget,
} from '../content-broadcasts';
import { requireIdempotencyKey } from '../wallet-domain';

const manualBroadcastSchema = z.object({
  entityType: z.enum(['event', 'feed_post', 'product']),
  entityId: z.uuid(),
});

function manualBroadcastId(input: {
  actorId: string;
  idempotencyKey: string;
  entityType: string;
  entityId: string;
}): string {
  return createHash('sha256')
    .update([input.actorId, input.idempotencyKey, input.entityType, input.entityId].join(':'))
    .digest('hex');
}

function unavailableMessage(
  entityType: z.infer<typeof manualBroadcastSchema>['entityType'],
): string {
  if (entityType === 'event') {
    return 'Рассылку можно отправить только для опубликованного или идущего мероприятия';
  }
  if (entityType === 'feed_post') {
    return 'Рассылку можно отправить только для уже опубликованной новости с аудиторией «Все»';
  }
  return 'Рассылку можно отправить только для опубликованного и доступного сейчас товара';
}

export const adminBroadcastRoutes: FastifyPluginAsync = async (app) => {
  const writeGuards = [app.requireAuth, app.requireCsrf, app.requireAdmin];

  app.post(
    '/admin/broadcasts',
    { preHandler: writeGuards, schema: { tags: ['admin'] } },
    async (request, reply) => {
      const body = manualBroadcastSchema.parse(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const broadcastId = manualBroadcastId({
        actorId: request.currentUser!.id,
        idempotencyKey,
        entityType: body.entityType,
        entityId: body.entityId,
      });

      let target: ManualContentBroadcastTarget;
      if (body.entityType === 'event') {
        const [event] = await app.db
          .select()
          .from(events)
          .where(eq(events.id, body.entityId))
          .limit(1);
        if (!event) {
          throw new AppError('BROADCAST_TARGET_NOT_FOUND', 'Мероприятие не найдено', 404);
        }
        target = { entityType: 'event', record: event };
      } else if (body.entityType === 'feed_post') {
        const [post] = await app.db
          .select()
          .from(feedPosts)
          .where(eq(feedPosts.id, body.entityId))
          .limit(1);
        if (!post) {
          throw new AppError('BROADCAST_TARGET_NOT_FOUND', 'Публикация не найдена', 404);
        }
        target = { entityType: 'feed_post', record: post };
      } else {
        const [product] = await app.db
          .select()
          .from(storeProducts)
          .where(eq(storeProducts.id, body.entityId))
          .limit(1);
        if (!product) {
          throw new AppError('BROADCAST_TARGET_NOT_FOUND', 'Товар не найден', 404);
        }
        target = { entityType: 'product', record: product };
      }

      const plan = await enqueueManualContentBroadcast(app.db, target, broadcastId);
      if (!plan) {
        throw new AppError('BROADCAST_TARGET_NOT_PUBLIC', unavailableMessage(body.entityType), 409);
      }

      const [recipients] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.status, 'active'));
      const recipientCount = recipients?.count ?? 0;

      await writeAudit(request, {
        action: 'content.broadcast.enqueue',
        entityType: body.entityType,
        entityId: body.entityId,
        ...(body.entityType === 'event' ? { eventId: body.entityId } : {}),
        metadata: {
          broadcastId,
          broadcastType: plan.type,
          recipientCount,
        },
      });

      return reply.code(202).send({
        broadcastId,
        type: plan.type,
        status: 'queued' as const,
        recipientCount,
      });
    },
  );
};
