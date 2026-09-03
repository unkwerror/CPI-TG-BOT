import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  artifacts,
  eventParticipants,
  events,
  outboxEvents,
  submissions,
  userMessengerIdentities,
  users,
  walletAccounts,
} from '@cpi/db';
import { isCrmReadyFullName, profileUpdateSchema } from '@cpi/shared';
import { createSession, destroySession, ensureUserRole, loadAuthenticatedUser } from '../auth';
import { invalidateEventExports } from '../export-storage';
import { verifyMaxSharedContact } from '../max-contact';
import { ensureWalletBootstrap } from '../wallet-service';
import { serializeArtifact, serializeEvent, serializeSubmission } from '../serializers';

/**
 * Уточнённое ФИО чаще всего и было причиной, по которой CRM не приняла прошлые
 * отправки. Поэтому после правки профиля их синхронизация ставится заново:
 * событие в outbox могло быть давно обработано, а задача в очереди — упасть.
 */
async function requeueCrmSync(
  app: Parameters<FastifyPluginAsync>[0],
  userId: string,
): Promise<void> {
  await app.db
    .insert(outboxEvents)
    .values({
      type: 'crm.user.sync',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { userId },
    })
    .onConflictDoUpdate({
      target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
      set: {
        processedAt: null,
        availableAt: new Date(),
        attempts: 0,
        lastError: null,
      },
    });
  const pending = await app.db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.status, 'ready'),
        isNull(submissions.deletedAt),
        isNull(submissions.crmSyncedAt),
      ),
    )
    .limit(200);
  if (pending.length === 0) return;
  await app.db
    .insert(outboxEvents)
    .values(
      pending.map((submission) => ({
        type: 'crm.submission.sync',
        aggregateType: 'submission',
        aggregateId: submission.id,
        payload: { submissionId: submission.id },
      })),
    )
    .onConflictDoUpdate({
      target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
      set: {
        processedAt: null,
        availableAt: new Date(),
        attempts: 0,
        lastError: null,
      },
    });
  await app.db
    .update(submissions)
    .set({ crmSyncError: null, crmSyncFailedAt: null })
    .where(
      and(
        eq(submissions.userId, userId),
        isNull(submissions.crmSyncedAt),
        isNull(submissions.deletedAt),
      ),
    );
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/me',
    { preHandler: app.requireAuth, schema: { tags: ['profile'] } },
    async (request) => {
      const user = request.currentUser!;
      return {
        id: user.id,
        telegramUserId: user.telegramUserId?.toString() ?? null,
        messengerProvider:
          request.session?.messengerProvider ?? (user.telegramUserId ? 'telegram' : 'max'),
        messengerUserId:
          request.session?.messengerUserId ?? user.telegramUserId?.toString() ?? user.id,
        telegramUsername: user.telegramUsername,
        fullName: user.fullName,
        organization: user.organization,
        position: user.position,
        phone: user.phone,
        consentAt: user.consentAt,
        status: user.status,
        roles: user.roles,
        profileComplete: Boolean(isCrmReadyFullName(user.fullName) && user.consentAt),
      };
    },
  );

  app.patch(
    '/me',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['profile'] },
    },
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
      await ensureWalletBootstrap(app.db, request.currentUser!.id);
      await requeueCrmSync(app, request.currentUser!.id);
      const participations = await app.db
        .select({ eventId: eventParticipants.eventId })
        .from(eventParticipants)
        .where(eq(eventParticipants.userId, request.currentUser!.id));
      const invalidations = await Promise.allSettled(
        participations.map((participation) =>
          invalidateEventExports(
            app,
            participation.eventId,
            'Недействительна после изменения профиля участника',
          ),
        ),
      );
      for (const [index, invalidation] of invalidations.entries()) {
        if (invalidation.status === 'rejected') {
          app.log.warn(
            {
              error: invalidation.reason,
              eventId: participations[index]?.eventId,
            },
            'Export invalidation after profile update failed',
          );
        }
      }
      return {
        ...updated,
        telegramUserId: updated?.telegramUserId?.toString() ?? null,
        messengerProvider:
          request.session?.messengerProvider ?? (updated?.telegramUserId ? 'telegram' : 'max'),
        messengerUserId:
          request.session?.messengerUserId ??
          updated?.telegramUserId?.toString() ??
          updated?.id ??
          request.currentUser!.id,
        profileComplete: true,
      };
    },
  );

  app.post(
    '/me/max-contact',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: {
        tags: ['profile'],
        summary: 'Проверить номер MAX и связать общий профиль',
      },
    },
    async (request, reply) => {
      if (
        request.session?.messengerProvider !== 'max' ||
        !request.session.messengerUserId ||
        !app.config.MAX_BOT_TOKEN
      ) {
        return reply.code(400).send({
          error: {
            code: 'MAX_SESSION_REQUIRED',
            message: 'Откройте профиль из бота MAX',
          },
        });
      }
      const body = z
        .object({
          phone: z.string().min(7).max(64),
          authDate: z.string().min(10).max(16),
          hash: z.string().min(64).max(128),
        })
        .strict()
        .parse(request.body);
      const externalUserId = request.session.messengerUserId;
      const phone = verifyMaxSharedContact(body, externalUserId, app.config.MAX_BOT_TOKEN, {
        maxAgeSeconds: app.config.MAX_AUTH_MAX_AGE_SECONDS,
      });
      const phoneDigits = phone.slice(1);
      const currentUserId = request.currentUser!.id;
      const [current] = await app.db
        .select()
        .from(users)
        .where(eq(users.id, currentUserId))
        .limit(1);
      if (!current) throw new Error('MAX session user disappeared');

      const candidates = await app.db
        .select()
        .from(users)
        .where(
          and(
            ne(users.id, currentUserId),
            eq(users.status, 'active'),
            isNotNull(users.telegramUserId),
            sql`regexp_replace(coalesce(${users.phone}, ''), '[^0-9]', '', 'g') = ${phoneDigits}`,
          ),
        )
        .orderBy(desc(users.lastSeenAt))
        .limit(2);
      const candidate = candidates.length === 1 ? candidates[0] : undefined;

      const pristineMaxProfile =
        current.telegramUserId === null &&
        current.fullName === null &&
        current.consentAt === null &&
        current.crmPersonId === null;
      let resolvedUserId = currentUserId;
      let linked = false;
      if (candidate && pristineMaxProfile) {
        const [candidateMaxIdentity] = await app.db
          .select({ id: userMessengerIdentities.id })
          .from(userMessengerIdentities)
          .where(
            and(
              eq(userMessengerIdentities.userId, candidate.id),
              eq(userMessengerIdentities.provider, 'max'),
            ),
          )
          .limit(1);
        if (!candidateMaxIdentity) {
          await app.db.transaction(async (transaction) => {
            const linkedAt = new Date();
            const [movedIdentity] = await transaction
              .update(userMessengerIdentities)
              .set({
                userId: candidate.id,
                canMessage: true,
                lastSeenAt: linkedAt,
                updatedAt: linkedAt,
              })
              .where(
                and(
                  eq(userMessengerIdentities.userId, currentUserId),
                  eq(userMessengerIdentities.provider, 'max'),
                  eq(userMessengerIdentities.externalUserId, externalUserId),
                ),
              )
              .returning({ id: userMessengerIdentities.id });
            if (!movedIdentity) {
              throw new Error('MAX identity disappeared during linking');
            }
            await transaction
              .update(users)
              .set({ phone, lastSeenAt: linkedAt, updatedAt: linkedAt })
              .where(eq(users.id, candidate.id));
            await transaction
              .delete(outboxEvents)
              .where(
                and(
                  eq(outboxEvents.aggregateType, 'user'),
                  eq(outboxEvents.aggregateId, currentUserId),
                ),
              );
            // A freshly created messenger profile already owns an auditable wallet and welcome
            // ledger entries. Deleting that user would violate the wallet's RESTRICT foreign key
            // and, more importantly, erase the owner behind immutable accounting history. Retire
            // the placeholder instead: the MAX identity moves to the canonical Telegram user,
            // while its inaccessible historical wallet remains available for reconciliation.
            await transaction
              .update(walletAccounts)
              .set({ status: 'frozen', updatedAt: linkedAt })
              .where(
                and(eq(walletAccounts.userId, currentUserId), eq(walletAccounts.status, 'active')),
              );
            await transaction
              .update(users)
              .set({
                status: 'blocked',
                avatarUrl: null,
                lastSeenAt: linkedAt,
                updatedAt: linkedAt,
              })
              .where(eq(users.id, currentUserId));
          });
          resolvedUserId = candidate.id;
          linked = true;
          request.log.info(
            {
              sourceUserId: currentUserId,
              resolvedUserId,
              messengerProvider: 'max',
            },
            'Messenger profile linked to canonical user',
          );
        }
      }
      if (!linked) {
        await app.db
          .update(users)
          .set({ phone, lastSeenAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, currentUserId));
      }
      await ensureUserRole(app.db, resolvedUserId, 'participant');
      if (app.config.SUPERADMIN_MAX_IDS.includes(externalUserId)) {
        await ensureUserRole(app.db, resolvedUserId, 'superadmin');
      }
      await requeueCrmSync(app, resolvedUserId);
      await destroySession(app, reply, request.session.id);
      const session = await createSession(app, reply, resolvedUserId, {
        provider: 'max',
        externalUserId,
      });
      const authenticated = await loadAuthenticatedUser(app.db, resolvedUserId);
      if (!authenticated) throw new Error('Linked MAX user disappeared');
      return {
        linked,
        phone,
        user: {
          id: authenticated.id,
          telegramUserId: authenticated.telegramUserId?.toString() ?? null,
          messengerProvider: 'max' as const,
          messengerUserId: externalUserId,
          fullName: authenticated.fullName,
          roles: authenticated.roles,
          profileComplete: Boolean(
            isCrmReadyFullName(authenticated.fullName) && authenticated.consentAt,
          ),
        },
        csrfToken: session.csrfToken,
        sessionToken: session.id,
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
        return reply.code(404).send({
          error: {
            code: 'SUBMISSION_NOT_FOUND',
            message: 'Отправка не найдена',
          },
        });
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
