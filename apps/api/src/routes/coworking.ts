import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { auditLogs, coworkingBookings, users } from '@cpi/db';
import { AppError } from '@cpi/shared';
import {
  bookingCreateSchema,
  canChangeBookingStatus,
  coworkingStatuses,
  validateBookingWindow,
} from '../coworking-domain';

const idSchema = z.object({ id: z.uuid() });
const listSchema = z.object({
  status: z.enum(coworkingStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const updateSchema = z
  .object({
    status: z.enum(coworkingStatuses),
    adminNote: z.string().trim().max(1000).default(''),
  })
  .strict();

export const coworkingRoutes: FastifyPluginAsync = async (app) => {
  const read = [app.requireAuth];
  const write = [app.requireAuth, app.requireCsrf];
  const adminRead = [app.requireAuth, app.requireAdmin];
  const adminWrite = [app.requireAuth, app.requireCsrf, app.requireAdmin];

  app.get('/coworking/bookings/me', { preHandler: read }, async (request) => {
    const items = await app.db
      .select()
      .from(coworkingBookings)
      .where(eq(coworkingBookings.userId, request.currentUser!.id))
      .orderBy(desc(coworkingBookings.createdAt))
      .limit(50);
    return { items };
  });

  app.post(
    '/coworking/bookings',
    {
      preHandler: write,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = bookingCreateSchema.parse(request.body);
      const key = z.string().min(8).max(128).parse(request.headers['idempotency-key']);
      const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const userId = request.currentUser!.id;
      const result = await app.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${'coworking:' + userId}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(coworkingBookings)
          .where(
            and(eq(coworkingBookings.userId, userId), eq(coworkingBookings.idempotencyKey, key)),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              'Ключ уже использован для другой заявки',
              409,
            );
          return { row: existing, replayed: true };
        }
        const startsAt = new Date(body.startsAt),
          endsAt = new Date(body.endsAt);
        validateBookingWindow(startsAt, endsAt);
        const [created] = await tx
          .insert(coworkingBookings)
          .values({
            userId,
            startsAt,
            endsAt,
            attendees: body.attendees,
            purpose: body.purpose,
            idempotencyKey: key,
            requestHash,
          })
          .returning();
        if (!created) throw new Error('Booking insert returned no row');
        await tx.insert(auditLogs).values({
          actorUserId: userId,
          action: 'coworking.booking.create',
          entityType: 'coworking_booking',
          entityId: created.id,
          metadata: {
            startsAt: body.startsAt,
            endsAt: body.endsAt,
            attendees: body.attendees,
          },
        });
        return { row: created, replayed: false };
      });
      return reply.code(result.replayed ? 200 : 201).send(result.row);
    },
  );

  app.patch('/coworking/bookings/:id/cancel', { preHandler: write }, async (request) => {
    const { id } = idSchema.parse(request.params);
    return app.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(coworkingBookings)
        .where(
          and(eq(coworkingBookings.id, id), eq(coworkingBookings.userId, request.currentUser!.id)),
        )
        .for('update');
      if (!current) throw new AppError('BOOKING_NOT_FOUND', 'Заявка не найдена', 404);
      if (!canChangeBookingStatus(current.status, 'cancelled'))
        throw new AppError('BOOKING_CLOSED', 'Заявка уже закрыта', 409);
      if (current.status === 'cancelled') return current;
      const [updated] = await tx
        .update(coworkingBookings)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(coworkingBookings.id, id))
        .returning();
      await tx.insert(auditLogs).values({
        actorUserId: request.currentUser!.id,
        action: 'coworking.booking.cancel',
        entityType: 'coworking_booking',
        entityId: id,
      });
      return updated;
    });
  });

  app.get('/admin/coworking/bookings', { preHandler: adminRead }, async (request) => {
    const query = listSchema.parse(request.query);
    const rows = await app.db
      .select({
        booking: coworkingBookings,
        user: {
          id: users.id,
          fullName: users.fullName,
          username: users.telegramUsername,
          phone: users.phone,
        },
      })
      .from(coworkingBookings)
      .innerJoin(users, eq(users.id, coworkingBookings.userId))
      .where(query.status ? eq(coworkingBookings.status, query.status) : undefined)
      .orderBy(desc(coworkingBookings.createdAt), desc(coworkingBookings.id))
      .limit(query.limit + 1)
      .offset(query.offset);
    return {
      items: rows.slice(0, query.limit).map(({ booking, user }) => ({ ...booking, user })),
      hasMore: rows.length > query.limit,
    };
  });

  app.patch('/admin/coworking/bookings/:id', { preHandler: adminWrite }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const body = updateSchema.parse(request.body);
    return app.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(coworkingBookings)
        .where(eq(coworkingBookings.id, id))
        .for('update');
      if (!current) throw new AppError('BOOKING_NOT_FOUND', 'Заявка не найдена', 404);
      if (!canChangeBookingStatus(current.status, body.status))
        throw new AppError(
          'BOOKING_STATUS_CONFLICT',
          'Статус заявки уже изменился. Обновите список.',
          409,
        );
      if (body.status === 'confirmed' && current.startsAt <= new Date())
        throw new AppError('BOOKING_PAST', 'Нельзя подтвердить заявку на прошедшее время', 409);
      const [updated] = await tx
        .update(coworkingBookings)
        .set({
          status: body.status,
          adminNote: body.adminNote,
          reviewedBy: request.currentUser!.id,
          updatedAt: new Date(),
        })
        .where(eq(coworkingBookings.id, id))
        .returning();
      await tx.insert(auditLogs).values({
        actorUserId: request.currentUser!.id,
        action: 'coworking.booking.review',
        entityType: 'coworking_booking',
        entityId: id,
        metadata: { previousStatus: current.status, status: body.status },
      });
      return updated;
    });
  });
};
