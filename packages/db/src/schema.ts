import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  artifactKinds,
  artifactStatuses,
  eventFormats,
  eventRequestStatuses,
  eventStatuses,
  exportKinds,
  exportStatuses,
  roleNames,
  submissionStatuses,
  userSources,
  userStatuses,
} from '@cpi/shared';

export const userStatusEnum = pgEnum('user_status', userStatuses);
export const userSourceEnum = pgEnum('user_source', userSources);
export const roleNameEnum = pgEnum('role_name', roleNames);
export const eventStatusEnum = pgEnum('event_status', eventStatuses);
export const eventFormatEnum = pgEnum('event_format', eventFormats);
export const submissionStatusEnum = pgEnum('submission_status', submissionStatuses);
export const artifactStatusEnum = pgEnum('artifact_status', artifactStatuses);
export const artifactKindEnum = pgEnum('artifact_kind', artifactKinds);
export const exportStatusEnum = pgEnum('export_status', exportStatuses);
export const exportKindEnum = pgEnum('export_kind', exportKinds);
export const eventRequestStatusEnum = pgEnum('event_request_status', eventRequestStatuses);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull().unique(),
    telegramUsername: text('telegram_username'),
    telegramFirstName: text('telegram_first_name'),
    telegramLastName: text('telegram_last_name'),
    telegramLanguageCode: text('telegram_language_code'),
    fullName: text('full_name'),
    organization: text('organization'),
    position: text('position'),
    phone: text('phone'),
    crmPersonId: uuid('crm_person_id'),
    crmSyncedAt: timestamp('crm_synced_at', { withTimezone: true }),
    crmSyncError: text('crm_sync_error'),
    avatarUrl: text('avatar_url'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    status: userStatusEnum('status').notNull().default('active'),
    source: userSourceEnum('source').notNull().default('miniapp'),
    /** Когда человек впервые написал боту. Только по таким адресатам возможна рассылка. */
    botStartedAt: timestamp('bot_started_at', { withTimezone: true }),
    /** Telegram сообщил, что бот заблокирован: адресат недостижим до нового /start. */
    botBlockedAt: timestamp('bot_blocked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('users_username_idx').on(table.telegramUsername),
    index('users_last_seen_idx').on(table.lastSeenAt),
    index('users_created_idx').on(table.createdAt, table.id),
    index('users_bot_started_idx').on(table.botStartedAt),
    uniqueIndex('users_crm_person_uidx')
      .on(table.crmPersonId)
      .where(sql`${table.crmPersonId} is not null`),
  ],
);

export const roles = pgTable('roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: roleNameEnum('name').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    scopeEventId: uuid('scope_event_id'),
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index('user_roles_scope_idx').on(table.scopeEventId),
  ],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: text('title').notNull(),
    slug: text('slug').notNull().unique(),
    shortCode: text('short_code').notNull().unique(),
    description: text('description'),
    organizer: text('organizer').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull().default('Asia/Novosibirsk'),
    venue: text('venue'),
    city: text('city'),
    format: eventFormatEnum('format').notNull().default('offline'),
    status: eventStatusEnum('status').notNull().default('draft'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    searchText: text('search_text').notNull().default(''),
    coverUrl: text('cover_url'),
    acceptUploadsFrom: timestamp('accept_uploads_from', { withTimezone: true }).notNull(),
    acceptUploadsUntil: timestamp('accept_uploads_until', { withTimezone: true }).notNull(),
    maxFileSizeBytes: bigint('max_file_size_bytes', { mode: 'number' })
      .notNull()
      .default(524_288_000),
    allowedMimeTypes: text('allowed_mime_types')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    blockedExtensions: text('blocked_extensions')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    directAccessEnabled: boolean('direct_access_enabled').notNull().default(true),
    /** Мероприятие показывается в боте кнопкой «Выбрать событие» только с этим флагом. */
    acceptsRequests: boolean('accepts_requests').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('events_status_dates_idx').on(table.status, table.startsAt),
    index('events_city_idx').on(table.city),
    index('events_acceptance_idx').on(table.acceptUploadsFrom, table.acceptUploadsUntil),
    check('events_date_order_check', sql`${table.endsAt} >= ${table.startsAt}`),
    check(
      'events_acceptance_order_check',
      sql`${table.acceptUploadsUntil} >= ${table.acceptUploadsFrom}`,
    ),
    check('events_max_file_size_positive_check', sql`${table.maxFileSizeBytes} > 0`),
  ],
);

export const eventTags = pgTable(
  'event_tags',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.tag] }),
    index('event_tags_tag_idx').on(table.tag),
  ],
);

export const eventParticipants = pgTable(
  'event_participants',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull().default('opened'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastSubmissionAt: timestamp('last_submission_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.userId] }),
    index('event_participants_user_idx').on(table.userId),
  ],
);

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: text('title'),
    text: text('text'),
    link: text('link'),
    status: submissionStatusEnum('status').notNull().default('draft'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    crmArtifactId: uuid('crm_artifact_id'),
    crmArtifactVersionId: uuid('crm_artifact_version_id'),
    crmSyncedAt: timestamp('crm_synced_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('submissions_user_idempotency_uq').on(table.userId, table.idempotencyKey),
    index('submissions_event_created_idx').on(table.eventId, table.createdAt),
    index('submissions_user_created_idx').on(table.userId, table.createdAt),
    uniqueIndex('submissions_crm_artifact_uidx')
      .on(table.crmArtifactId)
      .where(sql`${table.crmArtifactId} is not null`),
    uniqueIndex('submissions_crm_version_uidx')
      .on(table.crmArtifactVersionId)
      .where(sql`${table.crmArtifactVersionId} is not null`),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: artifactKindEnum('kind').notNull().default('file'),
    originalName: text('original_name').notNull(),
    displayName: text('display_name').notNull(),
    mimeType: text('mime_type').notNull(),
    extension: text('extension').notNull().default(''),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    actualSizeBytes: bigint('actual_size_bytes', { mode: 'number' }),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull().unique(),
    uploadId: text('upload_id'),
    checksumSha256: text('checksum_sha256'),
    etag: text('etag'),
    status: artifactStatusEnum('status').notNull().default('created'),
    statusReason: text('status_reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    storageDeletedAt: timestamp('storage_deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('artifacts_user_idempotency_uq').on(table.userId, table.idempotencyKey),
    index('artifacts_submission_idx').on(table.submissionId),
    index('artifacts_event_status_idx').on(table.eventId, table.status),
    index('artifacts_user_created_idx').on(table.userId, table.createdAt),
    index('artifacts_storage_cleanup_idx').on(
      table.status,
      table.deletedAt,
      table.storageDeletedAt,
    ),
    check('artifacts_size_positive_check', sql`${table.sizeBytes} > 0`),
  ],
);

export const uploadParts = pgTable(
  'upload_parts',
  {
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    etag: text('etag').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.partNumber] }),
    check(
      'upload_parts_part_number_check',
      sql`${table.partNumber} >= 1 AND ${table.partNumber} <= 10000`,
    ),
  ],
);

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: exportKindEnum('kind').notNull(),
    status: exportStatusEnum('status').notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    bucket: text('bucket'),
    objectKey: text('object_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('export_jobs_event_created_idx').on(table.eventId, table.createdAt),
    index('export_jobs_status_idx').on(table.status),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_actor_created_idx').on(table.actorUserId, table.createdAt),
    index('audit_logs_event_created_idx').on(table.eventId, table.createdAt),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: text('type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbox_type_aggregate_uq').on(table.type, table.aggregateType, table.aggregateId),
    index('outbox_pending_idx').on(table.processedAt, table.availableAt),
  ],
);

/**
 * Запрос, оставленный словами в боте: человек выбирает мероприятие и описывает,
 * с чем нужна помощь. Разбирает его команда вручную, поэтому у запроса есть
 * только статус и ответственный, без автоматики.
 */
export const eventRequests = pgTable(
  'event_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** Ссылки на файлы Telegram: отвечают всё равно в чате, где вложение уже есть. */
    attachments: jsonb('attachments')
      .$type<Array<{ fileId: string; kind: string; fileName?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: eventRequestStatusEnum('status').notNull().default('new'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('event_requests_created_idx').on(table.createdAt, table.id),
    index('event_requests_status_idx').on(table.status, table.createdAt),
    index('event_requests_event_idx').on(table.eventId, table.createdAt),
    // Второе обращение по тому же мероприятию дописывается в открытый запрос,
    // иначе у команды копятся дубли об одном и том же.
    uniqueIndex('event_requests_open_uidx')
      .on(table.eventId, table.userId)
      .where(sql`${table.status} <> 'closed'`),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    deduplicationKey: text('deduplication_key').notNull().unique(),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('notification_deliveries_user_idx').on(table.userId, table.createdAt)],
);
