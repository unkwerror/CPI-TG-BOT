import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  artifacts,
  type Database,
  eventArtifactFields,
  eventParticipants,
  eventRewardPolicies,
  events,
  outboxEvents,
  submissionFieldValues,
  submissions,
} from '@cpi/db';
import {
  AppError,
  eventAcceptsUploads,
  eventListQuerySchema,
  isCrmReadyFullName,
  parseCursorPagination,
  submissionCreateSchema,
} from '@cpi/shared';
import { deleteArtifactObjects } from '../artifact-storage';
import { invalidateEventExports } from '../export-storage';
import { serializeArtifact, serializeEvent, serializeSubmission } from '../serializers';
import { serializePoints, walletRequestHash } from '../wallet-domain';

const formSubmissionSchema = z
  .object({
    ...submissionCreateSchema.shape,
    formVersionId: z.uuid().optional(),
    fieldValues: z
      .array(
        z
          .object({
            fieldId: z.uuid(),
            textValue: z.string().max(50_000).nullable().optional(),
            jsonValue: z.unknown().optional(),
          })
          .refine((value) => value.textValue != null || value.jsonValue !== undefined, {
            message: 'Значение поля отсутствует',
          }),
      )
      .max(100)
      .default([]),
  })
  .refine(
    (value) =>
      Boolean(
        value.title || value.text || value.link || value.hasFiles || value.fieldValues.length,
      ),
    { message: 'Заполните хотя бы одно поле или добавьте файл' },
  );

const FILE_FIELD_KINDS = new Set(['file', 'image', 'document', 'audio', 'video', 'archive']);

function serializeRewardPolicy(policy: typeof eventRewardPolicies.$inferSelect | undefined) {
  if (!policy) return null;
  const now = new Date();
  return {
    active:
      policy.enabled &&
      (!policy.validFrom || policy.validFrom <= now) &&
      (!policy.validUntil || policy.validUntil >= now),
    amount: serializePoints(policy.amount),
    trigger: policy.trigger,
    requiresManualApproval: policy.requiresManualApproval,
    validFrom: policy.validFrom,
    validUntil: policy.validUntil,
  };
}

async function assertSubmissionReplayMatches(
  database: Database,
  existing: typeof submissions.$inferSelect,
  eventId: string,
  body: z.infer<typeof formSubmissionSchema>,
): Promise<void> {
  const storedValues = existing.formVersionId
    ? await database
        .select({
          fieldId: submissionFieldValues.fieldId,
          textValue: submissionFieldValues.textValue,
          jsonValue: submissionFieldValues.jsonValue,
        })
        .from(submissionFieldValues)
        .where(eq(submissionFieldValues.submissionId, existing.id))
    : [];
  const [artifactEvidence] = await database
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.submissionId, existing.id))
    .limit(1);
  const storedHasFiles =
    Boolean(artifactEvidence) ||
    existing.submittedAt === null ||
    ['draft', 'processing'].includes(existing.status);
  const normalizeValues = (
    values: Array<{
      fieldId: string;
      textValue?: string | null | undefined;
      jsonValue?: unknown;
    }>,
  ) =>
    values
      .map((value) => ({
        fieldId: value.fieldId,
        textValue: value.textValue?.trim() || null,
        jsonValue: value.jsonValue === undefined ? null : value.jsonValue,
      }))
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  const storedHash = walletRequestHash({
    eventId: existing.eventId,
    title: existing.title,
    text: existing.text,
    link: existing.link,
    formVersionId: existing.formVersionId,
    hasFiles: storedHasFiles,
    fieldValues: normalizeValues(storedValues),
  });
  const requestHash = walletRequestHash({
    eventId,
    title: body.title ?? null,
    text: body.text ?? null,
    link: body.link ?? null,
    formVersionId: body.formVersionId ?? null,
    hasFiles: body.hasFiles,
    fieldValues: normalizeValues(body.fieldValues),
  });
  if (storedHash !== requestHash) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Этот Idempotency-Key уже использован для другой отправки',
      409,
    );
  }
}

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
      const participations =
        page.items.length === 0
          ? []
          : await app.db
              .select({ eventId: eventParticipants.eventId })
              .from(eventParticipants)
              .where(
                and(
                  eq(eventParticipants.userId, request.currentUser!.id),
                  inArray(
                    eventParticipants.eventId,
                    page.items.map((event) => event.id),
                  ),
                ),
              );
      const joinedEventIds = new Set(participations.map((item) => item.eventId));
      const policies =
        page.items.length === 0
          ? []
          : await app.db
              .select()
              .from(eventRewardPolicies)
              .where(
                inArray(
                  eventRewardPolicies.eventId,
                  page.items.map((event) => event.id),
                ),
              );
      const policiesByEvent = new Map(policies.map((policy) => [policy.eventId, policy]));
      return {
        items: page.items.map((event) => ({
          ...serializeEvent(event),
          isParticipant: joinedEventIds.has(event.id),
          rewardPolicy: serializeRewardPolicy(policiesByEvent.get(event.id)),
        })),
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
      const [participation] = await app.db
        .select({ eventId: eventParticipants.eventId })
        .from(eventParticipants)
        .where(
          and(
            eq(eventParticipants.eventId, event.id),
            eq(eventParticipants.userId, request.currentUser!.id),
          ),
        )
        .limit(1);
      const [policy] = await app.db
        .select()
        .from(eventRewardPolicies)
        .where(eq(eventRewardPolicies.eventId, event.id))
        .limit(1);
      return {
        ...serializeEvent(event),
        isParticipant: Boolean(participation),
        rewardPolicy: serializeRewardPolicy(policy),
      };
    },
  );

  app.post(
    '/events/:eventId/participate',
    {
      preHandler: [app.requireAuth, app.requireCsrf],
      schema: { tags: ['events'] },
    },
    async (request) => {
      const { eventId } = z.object({ eventId: z.uuid() }).parse(request.params);
      const userId = request.currentUser!.id;
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
      if (!event) {
        throw new AppError(
          'EVENT_PARTICIPATION_CLOSED',
          'Участие в этом мероприятии сейчас недоступно',
          409,
        );
      }

      const joined = await app.db.transaction(async (transaction) => {
        const [inserted] = await transaction
          .insert(eventParticipants)
          .values({ eventId, userId, source: 'joined_button' })
          .onConflictDoNothing()
          .returning({ eventId: eventParticipants.eventId });
        if (inserted) {
          await transaction
            .insert(outboxEvents)
            .values({
              type: 'crm.participation.sync',
              aggregateType: 'event_participation',
              aggregateId: `${eventId}:${userId}`,
              payload: { eventId, userId },
            })
            .onConflictDoUpdate({
              target: [outboxEvents.type, outboxEvents.aggregateType, outboxEvents.aggregateId],
              set: {
                payload: { eventId, userId },
                attempts: 0,
                availableAt: new Date(),
                processedAt: null,
                lastError: null,
              },
            });
        }
        return Boolean(inserted);
      });
      if (joined) {
        try {
          await invalidateEventExports(app, eventId, 'Недействительна после добавления участника');
        } catch (error) {
          app.log.warn({ error, eventId }, 'Export invalidation after participant join failed');
        }
      }
      return { joined, isParticipant: true };
    },
  );

  app.get(
    '/events/:eventId/submissions',
    { preHandler: app.requireAuth, schema: { tags: ['submissions'] } },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const ownSubmissions = await app.db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.eventId, eventId),
            eq(submissions.userId, request.currentUser!.id),
            isNull(submissions.deletedAt),
          ),
        )
        .orderBy(desc(submissions.createdAt))
        .limit(100);

      if (ownSubmissions.length === 0) return { items: [] };

      const files = await app.db
        .select()
        .from(artifacts)
        .where(
          and(
            inArray(
              artifacts.submissionId,
              ownSubmissions.map((submission) => submission.id),
            ),
            eq(artifacts.userId, request.currentUser!.id),
            isNull(artifacts.deletedAt),
          ),
        )
        .orderBy(desc(artifacts.createdAt));
      const filesBySubmission = new Map<string, typeof files>();
      for (const artifact of files) {
        const grouped = filesBySubmission.get(artifact.submissionId);
        if (grouped) grouped.push(artifact);
        else filesBySubmission.set(artifact.submissionId, [artifact]);
      }

      return {
        items: ownSubmissions.map((submission) => ({
          ...serializeSubmission(submission),
          artifacts: (filesBySubmission.get(submission.id) ?? []).map(serializeArtifact),
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
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 128
      ) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REQUIRED',
          'Передайте уникальный заголовок Idempotency-Key',
          400,
        );
      }
      const body = formSubmissionSchema.parse(request.body);
      const [replayedSubmission] = await app.db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.userId, request.currentUser!.id),
            eq(submissions.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (replayedSubmission) {
        await assertSubmissionReplayMatches(app.db, replayedSubmission, eventId, body);
        return reply.code(200).send(serializeSubmission(replayedSubmission));
      }
      if (!isCrmReadyFullName(request.currentUser!.fullName) || !request.currentUser!.consentAt) {
        throw new AppError(
          'PROFILE_INCOMPLETE',
          'Перед отправкой укажите фамилию, имя и отчество и подтвердите согласие',
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

      const normalizedFieldValues: Array<{
        fieldId: string;
        textValue: string | null;
        jsonValue: unknown;
      }> = [];
      if (event.activeFormVersionId) {
        if (body.formVersionId !== event.activeFormVersionId) {
          throw new AppError(
            'EVENT_FORM_VERSION_STALE',
            'Форма мероприятия обновилась. Откройте её заново.',
            409,
          );
        }
        const fields = await app.db
          .select()
          .from(eventArtifactFields)
          .where(eq(eventArtifactFields.formVersionId, event.activeFormVersionId));
        const fieldsById = new Map(fields.map((field) => [field.id, field]));
        const valuesById = new Map<string, (typeof body.fieldValues)[number]>();
        for (const value of body.fieldValues) {
          if (valuesById.has(value.fieldId)) {
            throw new AppError('EVENT_FIELD_DUPLICATED', 'Поле формы передано дважды', 400);
          }
          const field = fieldsById.get(value.fieldId);
          if (!field || FILE_FIELD_KINDS.has(field.kind)) {
            throw new AppError('EVENT_FIELD_INVALID', 'Поле не принадлежит активной форме', 400);
          }
          valuesById.set(value.fieldId, value);
        }
        for (const field of fields) {
          if (FILE_FIELD_KINDS.has(field.kind)) continue;
          const value = valuesById.get(field.id);
          if (field.required && !value) {
            throw new AppError('EVENT_FIELD_REQUIRED', `Заполните поле «${field.label}»`, 400);
          }
          if (!value) continue;
          const textValue = value.textValue?.trim() || null;
          const jsonValue = value.jsonValue === undefined ? null : value.jsonValue;
          if ((field.kind === 'text' || field.kind === 'link') && !textValue) {
            throw new AppError('EVENT_FIELD_REQUIRED', `Заполните поле «${field.label}»`, 400);
          }
          if (field.kind === 'link') {
            try {
              const link = new URL(textValue!);
              if (!['http:', 'https:'].includes(link.protocol)) throw new Error('protocol');
            } catch {
              throw new AppError(
                'EVENT_FIELD_URL_INVALID',
                `Проверьте ссылку «${field.label}»`,
                400,
              );
            }
          }
          if (textValue) {
            const configuredMin = Number(field.config.minLength ?? 0);
            const configuredMax = Number(field.config.maxLength ?? 50_000);
            const minLength =
              Number.isInteger(configuredMin) && configuredMin >= 0 ? configuredMin : 0;
            const maxLength =
              Number.isInteger(configuredMax) && configuredMax > 0
                ? Math.min(configuredMax, 50_000)
                : 50_000;
            if (textValue.length < minLength || textValue.length > maxLength) {
              throw new AppError(
                'EVENT_FIELD_LENGTH_INVALID',
                `Проверьте длину поля «${field.label}»`,
                400,
              );
            }
          }
          if (field.kind === 'checkbox' && typeof jsonValue !== 'boolean') {
            throw new AppError(
              'EVENT_FIELD_CHECKBOX_INVALID',
              `Проверьте поле «${field.label}»`,
              400,
            );
          }
          if (field.kind === 'checkbox' && field.required && jsonValue !== true) {
            throw new AppError('EVENT_FIELD_REQUIRED', `Подтвердите поле «${field.label}»`, 400);
          }
          normalizedFieldValues.push({ fieldId: field.id, textValue, jsonValue });
        }
        const hasRequiredFile = fields.some(
          (field) => FILE_FIELD_KINDS.has(field.kind) && (field.required || field.minItems > 0),
        );
        if (hasRequiredFile && !body.hasFiles) {
          throw new AppError('EVENT_FILE_REQUIRED', 'Добавьте обязательный файл', 400);
        }
      } else if (body.formVersionId || body.fieldValues.length > 0) {
        throw new AppError('EVENT_FORM_NOT_AVAILABLE', 'У мероприятия нет активной формы', 409);
      }

      const result = await app.db.transaction(async (transaction) => {
        const [lockedEvent] = await transaction
          .select()
          .from(events)
          .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
          .for('share')
          .limit(1);
        if (!lockedEvent) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
        if (!eventAcceptsUploads(lockedEvent)) {
          throw new AppError('EVENT_UPLOADS_CLOSED', 'Приём материалов сейчас закрыт', 409);
        }
        if ((body.formVersionId ?? null) !== (lockedEvent.activeFormVersionId ?? null)) {
          throw new AppError(
            'EVENT_FORM_VERSION_STALE',
            'Форма мероприятия обновилась. Откройте её заново.',
            409,
          );
        }
        const [created] = await transaction
          .insert(submissions)
          .values({
            eventId,
            userId: request.currentUser!.id,
            title: body.title ?? null,
            text: body.text ?? null,
            link: body.link ?? null,
            formVersionId: body.formVersionId ?? null,
            status: body.hasFiles ? 'draft' : 'ready',
            idempotencyKey,
            submittedAt: body.hasFiles ? null : new Date(),
          })
          .onConflictDoNothing({
            target: [submissions.userId, submissions.idempotencyKey],
          })
          .returning();
        if (!created) {
          const [concurrentReplay] = await transaction
            .select()
            .from(submissions)
            .where(
              and(
                eq(submissions.userId, request.currentUser!.id),
                eq(submissions.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (!concurrentReplay) throw new Error('Submission conflict row disappeared');
          await assertSubmissionReplayMatches(
            transaction as unknown as Database,
            concurrentReplay,
            eventId,
            body,
          );
          return { submission: concurrentReplay, created: false };
        }
        if (normalizedFieldValues.length > 0) {
          await transaction.insert(submissionFieldValues).values(
            normalizedFieldValues.map((value) => ({
              submissionId: created.id,
              ...value,
            })),
          );
        }
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
        if (!body.hasFiles) {
          await transaction
            .insert(outboxEvents)
            .values([
              {
                type: 'submission.ready',
                aggregateType: 'submission',
                aggregateId: created.id,
                payload: { submissionId: created.id },
              },
              {
                type: 'crm.submission.sync',
                aggregateType: 'submission',
                aggregateId: created.id,
                payload: { submissionId: created.id },
              },
            ])
            .onConflictDoNothing();
        }
        return { submission: created, created: true };
      });
      if (result.created) {
        try {
          await invalidateEventExports(app, eventId, 'Недействительна после добавления отправки');
        } catch (error) {
          app.log.warn({ error, eventId }, 'Export invalidation after submission creation failed');
        }
      }
      return reply.code(result.created ? 201 : 200).send(serializeSubmission(result.submission));
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
      const storedArtifacts = await app.db
        .select({
          id: artifacts.id,
          bucket: artifacts.bucket,
          objectKey: artifacts.objectKey,
          uploadId: artifacts.uploadId,
        })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.submissionId, submissionId),
            eq(artifacts.userId, request.currentUser!.id),
            isNull(artifacts.deletedAt),
          ),
        );
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
      try {
        await deleteArtifactObjects(app, storedArtifacts);
      } catch (error) {
        app.log.warn({ error, submissionId }, 'Submission artifact storage cleanup deferred');
      }
      try {
        await invalidateEventExports(app, eventId, 'Недействительна после удаления отправки');
      } catch (error) {
        app.log.warn({ error, eventId }, 'Export invalidation after submission deletion failed');
      }
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
