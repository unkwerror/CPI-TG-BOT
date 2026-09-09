import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
  eventStatuses,
  exportKinds,
  exportStatuses,
  roleNames,
  submissionStatuses,
  userStatuses,
} from '@cpi/shared';

export const userStatusEnum = pgEnum('user_status', userStatuses);
export const roleNameEnum = pgEnum('role_name', roleNames);
export const eventStatusEnum = pgEnum('event_status', eventStatuses);
export const eventFormatEnum = pgEnum('event_format', eventFormats);
export const submissionStatusEnum = pgEnum('submission_status', submissionStatuses);
export const artifactStatusEnum = pgEnum('artifact_status', artifactStatuses);
export const artifactKindEnum = pgEnum('artifact_kind', artifactKinds);
export const exportStatusEnum = pgEnum('export_status', exportStatuses);
export const exportKindEnum = pgEnum('export_kind', exportKinds);

export const pointSeasonStatuses = ['draft', 'active', 'closed'] as const;
export const walletAccountKinds = [
  'user',
  'system_issuance',
  'system_redemption',
  'store',
  'event',
] as const;
export const walletAccountStatuses = ['active', 'frozen', 'closed'] as const;
export const walletSystemKeys = {
  welcome: 'welcome',
  admin: 'admin',
  leaderId: 'leader_id',
  redemption: 'redemption',
  store: 'store',
} as const;
export const ledgerTransactionKinds = [
  'welcome_grant',
  'p2p_transfer',
  'staff_credit',
  'staff_debit',
  'artifact_reward',
  'leader_id_subscription_reward',
  'store_purchase',
  'admin_adjustment',
  'season_opening',
  'reversal',
] as const;
export const eventFormStatuses = ['draft', 'published', 'archived'] as const;
export const eventArtifactFieldKinds = [
  'text',
  'checkbox',
  'link',
  'file',
  'image',
  'document',
  'audio',
  'video',
  'archive',
] as const;
export const rewardTriggers = ['artifact_ready'] as const;
export const rewardClaimStatuses = ['granted', 'reversed'] as const;
export const productKinds = ['physical', 'digital'] as const;
export const productStatuses = ['draft', 'published', 'paused', 'archived'] as const;
export const productStockModes = ['limited', 'unlimited'] as const;
export const inventoryMovementKinds = [
  'restock',
  'reserve',
  'release',
  'fulfill',
  'adjustment',
] as const;
export const storeOrderStatuses = [
  'paid',
  'pickup_requested',
  'ready_for_pickup',
  'fulfilled',
] as const;
export const qrSessionPurposes = ['wallet', 'order_pickup'] as const;
export const qrSessionStatuses = ['active', 'claimed', 'consumed', 'expired', 'cancelled'] as const;
export const walletIntentKinds = ['p2p_transfer', 'staff_credit', 'staff_debit'] as const;
export const walletIntentStatuses = [
  'created',
  'awaiting_initiator_confirmation',
  'awaiting_owner_confirmation',
  'completed',
  'rejected',
  'cancelled',
  'expired',
] as const;
export const feedPostKinds = ['news', 'event', 'product', 'system'] as const;
export const feedPostStatuses = ['draft', 'published', 'archived'] as const;
export const feedPostAudiences = ['all', 'participants', 'admins'] as const;
export const richContentFormats = ['text', 'html'] as const;
export const customCardPackageEntityTypes = ['event', 'product', 'feed_post'] as const;
export type CustomCardPackageFile = {
  id: string;
  path: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
};
export const walletResetStatuses = [
  'draft',
  'previewed',
  'confirmed',
  'executing',
  'completed',
  'failed',
  'cancelled',
] as const;
export const eventRequestStatuses = ['new', 'in_progress', 'closed'] as const;
export const submissionSourceKinds = ['submission', 'event_request'] as const;
export const messengerProviders = ['telegram', 'max'] as const;
export const leaderIdRegistrationStatuses = [
  'REGISTERED',
  'ALREADY_REGISTERED',
  'PENDING_APPROVAL',
  'QUESTIONNAIRE_REQUIRED',
  'REGISTRATION_CLOSED',
  'EVENT_NOT_AVAILABLE',
  'FAILED',
] as const;
export const leaderIdRewardReason = 'LEADER_ID_CATALYST_SUBSCRIPTION' as const;

export const pointSeasonStatusEnum = pgEnum('point_season_status', pointSeasonStatuses);
export const walletAccountKindEnum = pgEnum('wallet_account_kind', walletAccountKinds);
export const walletAccountStatusEnum = pgEnum('wallet_account_status', walletAccountStatuses);
export const ledgerTransactionKindEnum = pgEnum('ledger_transaction_kind', ledgerTransactionKinds);
export const eventFormStatusEnum = pgEnum('event_form_status', eventFormStatuses);
export const eventArtifactFieldKindEnum = pgEnum(
  'event_artifact_field_kind',
  eventArtifactFieldKinds,
);
export const rewardTriggerEnum = pgEnum('reward_trigger', rewardTriggers);
export const rewardClaimStatusEnum = pgEnum('reward_claim_status', rewardClaimStatuses);
export const productKindEnum = pgEnum('product_kind', productKinds);
export const productStatusEnum = pgEnum('product_status', productStatuses);
export const productStockModeEnum = pgEnum('product_stock_mode', productStockModes);
export const inventoryMovementKindEnum = pgEnum('inventory_movement_kind', inventoryMovementKinds);
export const storeOrderStatusEnum = pgEnum('store_order_status', storeOrderStatuses);
export const qrSessionPurposeEnum = pgEnum('qr_session_purpose', qrSessionPurposes);
export const qrSessionStatusEnum = pgEnum('qr_session_status', qrSessionStatuses);
export const walletIntentKindEnum = pgEnum('wallet_intent_kind', walletIntentKinds);
export const walletIntentStatusEnum = pgEnum('wallet_intent_status', walletIntentStatuses);
export const feedPostKindEnum = pgEnum('feed_post_kind', feedPostKinds);
export const feedPostStatusEnum = pgEnum('feed_post_status', feedPostStatuses);
export const feedPostAudienceEnum = pgEnum('feed_post_audience', feedPostAudiences);
export const walletResetStatusEnum = pgEnum('wallet_reset_status', walletResetStatuses);
export const eventRequestStatusEnum = pgEnum('event_request_status', eventRequestStatuses);
export const messengerProviderEnum = pgEnum('messenger_provider', messengerProviders);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).unique(),
    telegramUsername: text('telegram_username'),
    telegramFirstName: text('telegram_first_name'),
    telegramLastName: text('telegram_last_name'),
    telegramLanguageCode: text('telegram_language_code'),
    fullName: text('full_name'),
    organization: text('organization'),
    position: text('position'),
    phone: text('phone'),
    crmPersonId: uuid('crm_person_id'),
    avatarUrl: text('avatar_url'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    status: userStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('users_username_idx').on(table.telegramUsername),
    index('users_last_seen_idx').on(table.lastSeenAt),
    uniqueIndex('users_crm_person_uidx')
      .on(table.crmPersonId)
      .where(sql`${table.crmPersonId} is not null`),
  ],
);

export const userMessengerIdentities = pgTable(
  'user_messenger_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: messengerProviderEnum('provider').notNull(),
    externalUserId: text('external_user_id').notNull(),
    chatId: text('chat_id'),
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    languageCode: text('language_code'),
    avatarUrl: text('avatar_url'),
    canMessage: boolean('can_message').notNull().default(true),
    firstBotStartedAt: timestamp('first_bot_started_at', { withTimezone: true }),
    firstAppOpenedAt: timestamp('first_app_opened_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_messenger_identities_provider_external_uq').on(
      table.provider,
      table.externalUserId,
    ),
    uniqueIndex('user_messenger_identities_user_provider_uq').on(table.userId, table.provider),
    index('user_messenger_identities_user_idx').on(table.userId),
    index('user_messenger_identities_delivery_idx').on(table.provider, table.canMessage),
    check(
      'user_messenger_identities_external_numeric_check',
      sql`${table.externalUserId} ~ '^[0-9]+$'`,
    ),
    check(
      'user_messenger_identities_chat_numeric_check',
      sql`${table.chatId} is null or ${table.chatId} ~ '^-?[0-9]+$'`,
    ),
  ],
);

export const leaderIdBindings = pgTable(
  'leader_id_bindings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    leaderIdUserId: bigint('leader_id_user_id', { mode: 'number' }).notNull(),
    encryptedTokens: text('encrypted_tokens').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('leader_id_bindings_external_user_uq').on(table.leaderIdUserId),
    check(
      'leader_id_bindings_external_user_check',
      sql`${table.leaderIdUserId} > 0 AND ${table.leaderIdUserId} <= 9007199254740991`,
    ),
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
    assignedBy: uuid('assigned_by').references(() => users.id, {
      onDelete: 'set null',
    }),
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
    descriptionFormat: text('description_format')
      .$type<(typeof richContentFormats)[number]>()
      .notNull()
      .default('text'),
    cardHtml: text('card_html'),
    cardPackageId: uuid('card_package_id').references((): AnyPgColumn => customCardPackages.id, {
      onDelete: 'set null',
    }),
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
    acceptUploadsFrom: timestamp('accept_uploads_from', {
      withTimezone: true,
    }).notNull(),
    acceptUploadsUntil: timestamp('accept_uploads_until', {
      withTimezone: true,
    }).notNull(),
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
    acceptsRequests: boolean('accepts_requests').notNull().default(false),
    managedByCrm: boolean('managed_by_crm').notNull().default(false),
    leaderIdEventId: bigint('leader_id_event_id', { mode: 'number' }),
    leaderIdRegistrationActive: boolean('leader_id_registration_active').notNull().default(false),
    leaderIdRequiredForSubscription: boolean('leader_id_required_for_subscription')
      .notNull()
      .default(true),
    leaderIdRegistrationOpen: boolean('leader_id_registration_open').notNull().default(true),
    leaderIdSortOrder: integer('leader_id_sort_order').notNull().default(0),
    leaderIdRequiresQuestionnaire: boolean('leader_id_requires_questionnaire')
      .notNull()
      .default(false),
    activeFormVersionId: uuid('active_form_version_id').references(
      (): AnyPgColumn => eventFormVersions.id,
      { onDelete: 'set null' },
    ),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('events_status_dates_idx').on(table.status, table.startsAt),
    index('events_city_idx').on(table.city),
    index('events_card_package_idx').on(table.cardPackageId),
    uniqueIndex('events_leader_id_event_uq')
      .on(table.leaderIdEventId)
      .where(sql`${table.leaderIdEventId} IS NOT NULL`),
    index('events_leader_id_active_order_idx').on(
      table.leaderIdRegistrationActive,
      table.leaderIdSortOrder,
    ),
    index('events_acceptance_idx').on(table.acceptUploadsFrom, table.acceptUploadsUntil),
    check('events_date_order_check', sql`${table.endsAt} >= ${table.startsAt}`),
    check(
      'events_acceptance_order_check',
      sql`${table.acceptUploadsUntil} >= ${table.acceptUploadsFrom}`,
    ),
    check('events_max_file_size_positive_check', sql`${table.maxFileSizeBytes} > 0`),
    check('events_description_format_check', sql`${table.descriptionFormat} IN ('text', 'html')`),
    check(
      'events_leader_id_external_check',
      sql`${table.leaderIdEventId} IS NULL OR (${table.leaderIdEventId} > 0 AND ${table.leaderIdEventId} <= 9007199254740991)`,
    ),
    check(
      'events_leader_id_active_requires_id_check',
      sql`${table.leaderIdRegistrationActive} = false OR ${table.leaderIdEventId} IS NOT NULL`,
    ),
  ],
);

export const leaderIdEventRegistrations = pgTable(
  'leader_id_event_registrations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    leaderIdUserId: bigint('leader_id_user_id', { mode: 'number' }).notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    leaderIdEventId: bigint('leader_id_event_id', { mode: 'number' }).notNull(),
    status: text('status').$type<(typeof leaderIdRegistrationStatuses)[number]>().notNull(),
    retryable: boolean('retryable').notNull().default(false),
    officialParticipationId: text('official_participation_id'),
    officialModeration: text('official_moderation'),
    errorCode: text('error_code'),
    attemptCount: integer('attempt_count').notNull().default(0),
    attemptClaimToken: uuid('attempt_claim_token'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('leader_id_event_registrations_user_event_uq').on(table.userId, table.eventId),
    index('leader_id_event_registrations_user_status_idx').on(table.userId, table.status),
    check(
      'leader_id_event_registrations_external_user_check',
      sql`${table.leaderIdUserId} > 0 AND ${table.leaderIdUserId} <= 9007199254740991`,
    ),
    check(
      'leader_id_event_registrations_external_event_check',
      sql`${table.leaderIdEventId} > 0 AND ${table.leaderIdEventId} <= 9007199254740991`,
    ),
    check(
      'leader_id_event_registrations_status_check',
      sql`${table.status} IN ('REGISTERED', 'ALREADY_REGISTERED', 'PENDING_APPROVAL', 'QUESTIONNAIRE_REQUIRED', 'REGISTRATION_CLOSED', 'EVENT_NOT_AVAILABLE', 'FAILED')`,
    ),
    check(
      'leader_id_event_registrations_moderation_check',
      sql`${table.officialModeration} IS NULL OR ${table.officialModeration} IN ('wait', 'approved', 'declined')`,
    ),
    check('leader_id_event_registrations_attempt_check', sql`${table.attemptCount} >= 0`),
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
    attachments: jsonb('attachments').$type<Array<Record<string, unknown>>>().notNull().default([]),
    status: eventRequestStatusEnum('status').notNull().default('new'),
    assignedTo: uuid('assigned_to').references(() => users.id, {
      onDelete: 'set null',
    }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('event_requests_event_idx').on(table.eventId, table.createdAt),
    index('event_requests_status_idx').on(table.status, table.createdAt),
    index('event_requests_created_idx').on(table.createdAt, table.id),
    uniqueIndex('event_requests_open_uidx')
      .on(table.eventId, table.userId)
      .where(sql`${table.status} <> 'closed'`),
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
    sourceKind: text('source_kind')
      .$type<(typeof submissionSourceKinds)[number]>()
      .notNull()
      .default('submission'),
    formVersionId: uuid('form_version_id').references((): AnyPgColumn => eventFormVersions.id, {
      onDelete: 'set null',
    }),
    status: submissionStatusEnum('status').notNull().default('draft'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    crmArtifactId: uuid('crm_artifact_id'),
    crmArtifactVersionId: uuid('crm_artifact_version_id'),
    crmTaskId: uuid('crm_task_id'),
    crmSyncedAt: timestamp('crm_synced_at', { withTimezone: true }),
    /** CRM приняла отправку, но не смогла определить участника — ждёт ручного разбора. */
    crmPendingReviewAt: timestamp('crm_pending_review_at', {
      withTimezone: true,
    }),
    crmSyncError: text('crm_sync_error'),
    crmSyncFailedAt: timestamp('crm_sync_failed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('submissions_user_idempotency_uq').on(table.userId, table.idempotencyKey),
    index('submissions_crm_unsynced_idx')
      .on(table.userId)
      .where(sql`${table.crmSyncedAt} is null and ${table.deletedAt} is null`),
    index('submissions_event_created_idx').on(table.eventId, table.createdAt),
    index('submissions_user_created_idx').on(table.userId, table.createdAt),
    uniqueIndex('submissions_crm_artifact_uidx')
      .on(table.crmArtifactId)
      .where(sql`${table.crmArtifactId} is not null`),
    uniqueIndex('submissions_crm_version_uidx')
      .on(table.crmArtifactVersionId)
      .where(sql`${table.crmArtifactVersionId} is not null`),
    uniqueIndex('submissions_crm_task_uidx')
      .on(table.crmTaskId)
      .where(sql`${table.crmTaskId} is not null`),
    check(
      'submissions_source_kind_check',
      sql`${table.sourceKind} in ('submission', 'event_request')`,
    ),
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
    formFieldId: uuid('form_field_id').references((): AnyPgColumn => eventArtifactFields.id, {
      onDelete: 'set null',
    }),
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
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'restrict' }),
    scope: text('scope').$type<'event' | 'quick_answers' | 'users'>().notNull().default('event'),
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
    check(
      'export_jobs_scope_check',
      sql`(${table.scope} IN ('event', 'quick_answers') AND ${table.eventId} IS NOT NULL) OR (${table.scope} = 'users' AND ${table.eventId} IS NULL AND ${table.kind} = 'xlsx')`,
    ),
  ],
);

export const eventQuickAnswers = pgTable(
  'event_quick_answers',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    answer: text('answer').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.userId] }),
    check('event_quick_answers_text_check', sql`length(trim(${table.answer})) BETWEEN 1 AND 10000`),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    eventId: uuid('event_id').references(() => events.id, {
      onDelete: 'set null',
    }),
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

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    deduplicationKey: text('deduplication_key').notNull().unique(),
    messengerProvider: messengerProviderEnum('messenger_provider'),
    externalMessageId: text('external_message_id'),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('notification_deliveries_user_idx').on(table.userId, table.createdAt)],
);

export const pointPrograms = pgTable(
  'point_programs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: text('code').notNull().unique(),
    walletTitle: text('wallet_title').notNull().default('Мои баллы'),
    unitOne: text('unit_one').notNull().default('балл'),
    unitFew: text('unit_few').notNull().default('балла'),
    unitMany: text('unit_many').notNull().default('баллов'),
    symbol: text('symbol'),
    iconUrl: text('icon_url'),
    welcomeAmount: bigint('welcome_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`100`),
    leaderIdSubscriptionReward: bigint('leader_id_subscription_reward', {
      mode: 'bigint',
    })
      .notNull()
      .default(sql`0`),
    maxTransactionAmount: bigint('max_transaction_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`100000`),
    qrTtlSeconds: integer('qr_ttl_seconds').notNull().default(120),
    intentTtlSeconds: integer('intent_ttl_seconds').notNull().default(90),
    p2pEnabled: boolean('p2p_enabled').notNull().default(true),
    storeEnabled: boolean('store_enabled').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    activeSeasonId: uuid('active_season_id').references((): AnyPgColumn => pointSeasons.id, {
      onDelete: 'restrict',
    }),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('point_programs_default_uidx')
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
    check('point_programs_welcome_nonnegative_check', sql`${table.welcomeAmount} >= 0`),
    check(
      'point_programs_leader_id_reward_nonnegative_check',
      sql`${table.leaderIdSubscriptionReward} >= 0`,
    ),
    check(
      'point_programs_max_transaction_check',
      sql`${table.maxTransactionAmount} > 0 AND ${table.maxTransactionAmount} <= 1000000000`,
    ),
    check('point_programs_qr_ttl_check', sql`${table.qrTtlSeconds} BETWEEN 15 AND 600`),
    check('point_programs_intent_ttl_check', sql`${table.intentTtlSeconds} BETWEEN 15 AND 900`),
  ],
);

export const pointSeasons = pgTable(
  'point_seasons',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    title: text('title').notNull(),
    status: pointSeasonStatusEnum('status').notNull().default('draft'),
    openingAmount: bigint('opening_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('point_seasons_program_code_uq').on(table.programId, table.code),
    uniqueIndex('point_seasons_active_uidx')
      .on(table.programId)
      .where(sql`${table.status} = 'active'`),
    check('point_seasons_opening_nonnegative_check', sql`${table.openingAmount} >= 0`),
    check(
      'point_seasons_dates_check',
      sql`${table.endsAt} IS NULL OR ${table.startsAt} IS NULL OR ${table.endsAt} >= ${table.startsAt}`,
    ),
  ],
);

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => pointSeasons.id, { onDelete: 'restrict' }),
    ownerKind: walletAccountKindEnum('owner_kind').notNull(),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    eventId: uuid('event_id').references(() => events.id, {
      onDelete: 'restrict',
    }),
    systemKey: text('system_key'),
    title: text('title').notNull(),
    balance: bigint('balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    allowNegative: boolean('allow_negative').notNull().default(false),
    status: walletAccountStatusEnum('status').notNull().default('active'),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wallet_accounts_user_uidx')
      .on(table.programId, table.seasonId, table.userId)
      .where(sql`${table.ownerKind} = 'user' AND ${table.userId} IS NOT NULL`),
    uniqueIndex('wallet_accounts_system_uidx')
      .on(table.programId, table.seasonId, table.systemKey)
      .where(sql`${table.systemKey} IS NOT NULL`),
    uniqueIndex('wallet_accounts_event_uidx')
      .on(table.programId, table.seasonId, table.eventId)
      .where(sql`${table.ownerKind} = 'event' AND ${table.eventId} IS NOT NULL`),
    index('wallet_accounts_user_idx').on(table.userId, table.seasonId),
    check(
      'wallet_accounts_owner_check',
      sql`(
        ${table.ownerKind} = 'user'
        AND ${table.userId} IS NOT NULL
        AND ${table.systemKey} IS NULL
        AND ${table.eventId} IS NULL
        AND ${table.allowNegative} = false
      ) OR (
        ${table.ownerKind} = 'event'
        AND ${table.userId} IS NULL
        AND ${table.systemKey} IS NOT NULL
        AND ${table.eventId} IS NOT NULL
      ) OR (
        ${table.ownerKind} NOT IN ('user', 'event')
        AND ${table.userId} IS NULL
        AND ${table.systemKey} IS NOT NULL
        AND ${table.eventId} IS NULL
      )`,
    ),
    check(
      'wallet_accounts_balance_check',
      sql`${table.allowNegative} = true OR ${table.balance} >= 0`,
    ),
    check('wallet_accounts_version_check', sql`${table.version} >= 0`),
  ],
);

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => pointSeasons.id, { onDelete: 'restrict' }),
    kind: ledgerTransactionKindEnum('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash'),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    subjectUserId: uuid('subject_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    eventId: uuid('event_id').references(() => events.id, {
      onDelete: 'set null',
    }),
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),
    relatedOrderId: uuid('related_order_id').references((): AnyPgColumn => storeOrders.id, {
      onDelete: 'set null',
    }),
    reversalOfTransactionId: uuid('reversal_of_transaction_id').references(
      (): AnyPgColumn => ledgerTransactions.id,
      { onDelete: 'restrict' },
    ),
    reason: text('reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ledger_transactions_idempotency_uq').on(table.programId, table.idempotencyKey),
    uniqueIndex('ledger_transactions_reversal_uidx')
      .on(table.reversalOfTransactionId)
      .where(sql`${table.reversalOfTransactionId} IS NOT NULL`),
    index('ledger_transactions_season_created_idx').on(table.seasonId, table.createdAt),
    index('ledger_transactions_subject_created_idx').on(table.subjectUserId, table.createdAt),
    index('ledger_transactions_event_created_idx').on(table.eventId, table.createdAt),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => walletAccounts.id, { onDelete: 'restrict' }),
    delta: bigint('delta', { mode: 'bigint' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ledger_entries_transaction_account_uq').on(table.transactionId, table.accountId),
    index('ledger_entries_account_history_idx').on(table.accountId, table.id),
    check('ledger_entries_delta_nonzero_check', sql`${table.delta} <> 0`),
  ],
);

export const leaderIdRewardGrants = pgTable(
  'leader_id_reward_grants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => pointSeasons.id, { onDelete: 'restrict' }),
    reason: text('reason')
      .$type<typeof leaderIdRewardReason>()
      .notNull()
      .default(leaderIdRewardReason),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    qualifyingEventIds: jsonb('qualifying_event_ids').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('leader_id_reward_grants_user_reason_uq').on(table.userId, table.reason),
    uniqueIndex('leader_id_reward_grants_transaction_uq').on(table.transactionId),
    index('leader_id_reward_grants_program_season_idx').on(table.programId, table.seasonId),
    check(
      'leader_id_reward_grants_reason_check',
      sql`${table.reason} = 'LEADER_ID_CATALYST_SUBSCRIPTION'`,
    ),
    check('leader_id_reward_grants_amount_positive_check', sql`${table.amount} > 0`),
  ],
);

export const eventFormVersions = pgTable(
  'event_form_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: eventFormStatusEnum('status').notNull().default('draft'),
    title: text('title').notNull(),
    instructions: text('instructions'),
    submitButtonLabel: text('submit_button_label').notNull().default('Отправить'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('event_form_versions_event_version_uq').on(table.eventId, table.version),
    uniqueIndex('event_form_versions_published_uidx')
      .on(table.eventId)
      .where(sql`${table.status} = 'published'`),
    check('event_form_versions_version_positive_check', sql`${table.version} > 0`),
  ],
);

export const eventArtifactFields = pgTable(
  'event_artifact_fields',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    formVersionId: uuid('form_version_id')
      .notNull()
      .references(() => eventFormVersions.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    kind: eventArtifactFieldKindEnum('kind').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    required: boolean('required').notNull().default(false),
    minItems: integer('min_items').notNull().default(0),
    maxItems: integer('max_items').notNull().default(1),
    allowedMimeTypes: text('allowed_mime_types')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    allowedExtensions: text('allowed_extensions')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    maxFileSizeBytes: bigint('max_file_size_bytes', { mode: 'number' }),
    sortOrder: integer('sort_order').notNull().default(0),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('event_artifact_fields_form_code_uq').on(table.formVersionId, table.code),
    index('event_artifact_fields_form_order_idx').on(table.formVersionId, table.sortOrder),
    check('event_artifact_fields_min_check', sql`${table.minItems} >= 0`),
    check(
      'event_artifact_fields_max_check',
      sql`${table.maxItems} >= 1 AND ${table.maxItems} >= ${table.minItems}`,
    ),
    check(
      'event_artifact_fields_size_check',
      sql`${table.maxFileSizeBytes} IS NULL OR ${table.maxFileSizeBytes} > 0`,
    ),
  ],
);

export const submissionFieldValues = pgTable(
  'submission_field_values',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => eventArtifactFields.id, { onDelete: 'restrict' }),
    textValue: text('text_value'),
    jsonValue: jsonb('json_value').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('submission_field_values_submission_field_uq').on(
      table.submissionId,
      table.fieldId,
    ),
    check(
      'submission_field_values_value_check',
      sql`${table.textValue} IS NOT NULL OR ${table.jsonValue} IS NOT NULL`,
    ),
  ],
);

export const eventRewardPolicies = pgTable(
  'event_reward_policies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    trigger: rewardTriggerEnum('trigger').notNull().default('artifact_ready'),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    requiresManualApproval: boolean('requires_manual_approval').notNull().default(false),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('event_reward_policies_event_uq').on(table.eventId),
    check('event_reward_policies_amount_positive_check', sql`${table.amount} > 0`),
    check(
      'event_reward_policies_dates_check',
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
  ],
);

export const eventRewardClaims = pgTable(
  'event_reward_claims',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => eventRewardPolicies.id, { onDelete: 'restrict' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict' }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    status: rewardClaimStatusEnum('status').notNull().default('granted'),
    reversedByTransactionId: uuid('reversed_by_transaction_id').references(
      () => ledgerTransactions.id,
      { onDelete: 'restrict' },
    ),
    amountSnapshot: bigint('amount_snapshot', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('event_reward_claims_event_user_uq').on(table.eventId, table.userId),
    uniqueIndex('event_reward_claims_transaction_uq').on(table.transactionId),
    uniqueIndex('event_reward_claims_reversal_uidx')
      .on(table.reversedByTransactionId)
      .where(sql`${table.reversedByTransactionId} IS NOT NULL`),
    index('event_reward_claims_user_created_idx').on(table.userId, table.createdAt),
    check('event_reward_claims_amount_positive_check', sql`${table.amountSnapshot} > 0`),
  ],
);

export const storeCategories = pgTable(
  'store_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('store_categories_active_order_idx').on(table.active, table.sortOrder)],
);

export const storeProducts = pgTable(
  'store_products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    categoryId: uuid('category_id').references(() => storeCategories.id, {
      onDelete: 'set null',
    }),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    descriptionFormat: text('description_format')
      .$type<(typeof richContentFormats)[number]>()
      .notNull()
      .default('text'),
    cardHtml: text('card_html'),
    cardPackageId: uuid('card_package_id').references((): AnyPgColumn => customCardPackages.id, {
      onDelete: 'set null',
    }),
    kind: productKindEnum('kind').notNull().default('physical'),
    status: productStatusEnum('status').notNull().default('draft'),
    price: bigint('price', { mode: 'bigint' }).notNull(),
    stockMode: productStockModeEnum('stock_mode').notNull().default('limited'),
    perUserLimit: integer('per_user_limit'),
    availableFrom: timestamp('available_from', { withTimezone: true }),
    availableUntil: timestamp('available_until', { withTimezone: true }),
    pickupInstructions: text('pickup_instructions'),
    coverUrl: text('cover_url'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('store_products_status_order_idx').on(table.status, table.sortOrder),
    index('store_products_category_idx').on(table.categoryId, table.status),
    index('store_products_card_package_idx').on(table.cardPackageId),
    check('store_products_price_positive_check', sql`${table.price} > 0`),
    check(
      'store_products_description_format_check',
      sql`${table.descriptionFormat} IN ('text', 'html')`,
    ),
    check(
      'store_products_limit_check',
      sql`${table.perUserLimit} IS NULL OR ${table.perUserLimit} > 0`,
    ),
    check(
      'store_products_dates_check',
      sql`${table.availableUntil} IS NULL OR ${table.availableFrom} IS NULL OR ${table.availableUntil} >= ${table.availableFrom}`,
    ),
  ],
);

export const storeProductMedia = pgTable(
  'store_product_media',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => storeProducts.id, { onDelete: 'cascade' }),
    // Legacy media can still point at an external URL. New uploads stay private in S3 and
    // receive a short-lived signed URL only while serializing an API response.
    url: text('url'),
    bucket: text('bucket'),
    objectKey: text('object_key'),
    contentType: text('content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    uploadStatus: text('upload_status').$type<'pending' | 'ready'>().notNull().default('ready'),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }),
    altText: text('alt_text'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('store_product_media_product_order_idx').on(table.productId, table.sortOrder),
    index('store_product_media_product_status_order_idx').on(
      table.productId,
      table.uploadStatus,
      table.sortOrder,
    ),
    uniqueIndex('store_product_media_object_key_uq')
      .on(table.objectKey)
      .where(sql`${table.objectKey} IS NOT NULL`),
    check(
      'store_product_media_upload_status_check',
      sql`${table.uploadStatus} IN ('pending', 'ready')`,
    ),
    check(
      'store_product_media_storage_check',
      sql`(
        ${table.uploadStatus} = 'pending'
        AND ${table.url} IS NULL
        AND ${table.bucket} IS NOT NULL
        AND ${table.objectKey} IS NOT NULL
        AND ${table.contentType} IS NOT NULL
        AND ${table.sizeBytes} > 0
        AND ${table.uploadExpiresAt} IS NOT NULL
      ) OR (
        ${table.uploadStatus} = 'ready'
        AND (
          ${table.url} IS NOT NULL
          OR (
            ${table.bucket} IS NOT NULL
            AND ${table.objectKey} IS NOT NULL
            AND ${table.contentType} IS NOT NULL
            AND ${table.sizeBytes} > 0
          )
        )
      )`,
    ),
  ],
);

export const storeProductInventory = pgTable(
  'store_product_inventory',
  {
    productId: uuid('product_id')
      .primaryKey()
      .references(() => storeProducts.id, { onDelete: 'cascade' }),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    version: integer('version').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('store_product_inventory_on_hand_check', sql`${table.onHand} >= 0`),
    check('store_product_inventory_reserved_check', sql`${table.reserved} >= 0`),
    check('store_product_inventory_available_check', sql`${table.reserved} <= ${table.onHand}`),
    check('store_product_inventory_version_check', sql`${table.version} >= 0`),
  ],
);

export const storeOrders = pgTable(
  'store_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => pointSeasons.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: storeOrderStatusEnum('status').notNull().default('paid'),
    totalPoints: bigint('total_points', { mode: 'bigint' }).notNull(),
    paymentTransactionId: uuid('payment_transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' })
      .unique(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash'),
    comment: text('comment'),
    pickupInstructionsSnapshot: text('pickup_instructions_snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfilledBy: uuid('fulfilled_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('store_orders_user_idempotency_uq').on(table.userId, table.idempotencyKey),
    index('store_orders_user_created_idx').on(table.userId, table.createdAt),
    index('store_orders_status_created_idx').on(table.status, table.createdAt),
    check('store_orders_total_positive_check', sql`${table.totalPoints} > 0`),
  ],
);

export const storeOrderItems = pgTable(
  'store_order_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => storeOrders.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => storeProducts.id, { onDelete: 'restrict' }),
    titleSnapshot: text('title_snapshot').notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    quantity: integer('quantity').notNull(),
    lineTotal: bigint('line_total', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('store_order_items_order_product_uq').on(table.orderId, table.productId),
    check('store_order_items_unit_price_check', sql`${table.unitPrice} > 0`),
    check('store_order_items_quantity_check', sql`${table.quantity} > 0`),
    check(
      'store_order_items_line_total_check',
      sql`${table.lineTotal} = ${table.unitPrice} * ${table.quantity}`,
    ),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => storeProducts.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').references(() => storeOrders.id, {
      onDelete: 'restrict',
    }),
    kind: inventoryMovementKindEnum('kind').notNull(),
    quantity: integer('quantity').notNull(),
    onHandAfter: integer('on_hand_after').notNull(),
    reservedAfter: integer('reserved_after').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inventory_movements_product_created_idx').on(table.productId, table.createdAt),
    check('inventory_movements_quantity_nonzero_check', sql`${table.quantity} <> 0`),
    check(
      'inventory_movements_balances_check',
      sql`${table.onHandAfter} >= 0 AND ${table.reservedAfter} >= 0 AND ${table.reservedAfter} <= ${table.onHandAfter}`,
    ),
  ],
);

export const qrSessions = pgTable(
  'qr_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => pointSeasons.id, { onDelete: 'restrict' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    purpose: qrSessionPurposeEnum('purpose').notNull().default('wallet'),
    capabilities: text('capabilities')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    tokenHash: text('token_hash').notNull().unique(),
    status: qrSessionStatusEnum('status').notNull().default('active'),
    orderId: uuid('order_id').references(() => storeOrders.id, {
      onDelete: 'restrict',
    }),
    claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('qr_sessions_owner_status_idx').on(table.ownerUserId, table.status, table.expiresAt),
    index('qr_sessions_expiry_idx').on(table.status, table.expiresAt),
    check('qr_sessions_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'qr_sessions_order_purpose_check',
      sql`${table.purpose} <> 'order_pickup' OR ${table.orderId} IS NOT NULL`,
    ),
  ],
);

export const walletIntents = pgTable(
  'wallet_intents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => pointSeasons.id, { onDelete: 'restrict' }),
    qrSessionId: uuid('qr_session_id')
      .notNull()
      .references(() => qrSessions.id, { onDelete: 'restrict' })
      .unique(),
    kind: walletIntentKindEnum('kind').notNull(),
    status: walletIntentStatusEnum('status').notNull().default('created'),
    initiatorUserId: uuid('initiator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    payerAccountId: uuid('payer_account_id')
      .notNull()
      .references(() => walletAccounts.id, { onDelete: 'restrict' }),
    payeeAccountId: uuid('payee_account_id')
      .notNull()
      .references(() => walletAccounts.id, { onDelete: 'restrict' }),
    requiredConfirmerUserId: uuid('required_confirmer_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    reason: text('reason'),
    eventId: uuid('event_id').references(() => events.id, {
      onDelete: 'set null',
    }),
    orderId: uuid('order_id').references(() => storeOrders.id, {
      onDelete: 'set null',
    }),
    transactionId: uuid('transaction_id')
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' })
      .unique(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wallet_intents_initiator_idempotency_uq').on(
      table.initiatorUserId,
      table.idempotencyKey,
    ),
    index('wallet_intents_owner_status_idx').on(table.ownerUserId, table.status, table.expiresAt),
    index('wallet_intents_initiator_created_idx').on(table.initiatorUserId, table.createdAt),
    check('wallet_intents_amount_positive_check', sql`${table.amount} > 0`),
    check(
      'wallet_intents_distinct_accounts_check',
      sql`${table.payerAccountId} <> ${table.payeeAccountId}`,
    ),
    check('wallet_intents_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const feedPosts = pgTable(
  'feed_posts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: feedPostKindEnum('kind').notNull().default('news'),
    status: feedPostStatusEnum('status').notNull().default('draft'),
    audience: feedPostAudienceEnum('audience').notNull().default('all'),
    title: text('title').notNull(),
    summary: text('summary'),
    body: text('body').notNull(),
    bodyFormat: text('body_format')
      .$type<(typeof richContentFormats)[number]>()
      .notNull()
      .default('text'),
    cardHtml: text('card_html'),
    cardPackageId: uuid('card_package_id').references((): AnyPgColumn => customCardPackages.id, {
      onDelete: 'set null',
    }),
    coverUrl: text('cover_url'),
    coverBucket: text('cover_bucket'),
    coverObjectKey: text('cover_object_key'),
    coverContentType: text('cover_content_type'),
    coverSizeBytes: bigint('cover_size_bytes', { mode: 'number' }),
    ctaLabel: text('cta_label'),
    ctaUrl: text('cta_url'),
    eventId: uuid('event_id').references(() => events.id, {
      onDelete: 'set null',
    }),
    productId: uuid('product_id').references(() => storeProducts.id, {
      onDelete: 'set null',
    }),
    pinned: boolean('pinned').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('feed_posts_status_published_idx').on(table.status, table.publishedAt),
    index('feed_posts_card_package_idx').on(table.cardPackageId),
    check('feed_posts_body_format_check', sql`${table.bodyFormat} IN ('text', 'html')`),
    uniqueIndex('feed_posts_cover_object_key_uq')
      .on(table.coverObjectKey)
      .where(sql`${table.coverObjectKey} IS NOT NULL`),
    check(
      'feed_posts_cover_storage_check',
      sql`(
        ${table.coverBucket} IS NULL
        AND ${table.coverObjectKey} IS NULL
        AND ${table.coverContentType} IS NULL
        AND ${table.coverSizeBytes} IS NULL
      ) OR (
        ${table.coverUrl} IS NULL
        AND ${table.coverBucket} IS NOT NULL
        AND ${table.coverObjectKey} IS NOT NULL
        AND ${table.coverContentType} IS NOT NULL
        AND ${table.coverSizeBytes} > 0
      )`,
    ),
  ],
);

export const customCardPackages = pgTable(
  'custom_card_packages',
  {
    id: uuid('id').primaryKey(),
    entityType: text('entity_type')
      .$type<(typeof customCardPackageEntityTypes)[number]>()
      .notNull(),
    entityId: uuid('entity_id').notNull(),
    sourceFileName: text('source_file_name').notNull(),
    sourceBucket: text('source_bucket').notNull(),
    sourceObjectKey: text('source_object_key').notNull().unique(),
    sourceSizeBytes: bigint('source_size_bytes', { mode: 'number' }).notNull(),
    entryPath: text('entry_path').notNull(),
    entryHtml: text('entry_html').notNull(),
    files: jsonb('files').$type<CustomCardPackageFile[]>().notNull().default([]),
    totalUncompressedBytes: bigint('total_uncompressed_bytes', {
      mode: 'number',
    }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('custom_card_packages_entity_idx').on(table.entityType, table.entityId),
    check(
      'custom_card_packages_entity_type_check',
      sql`${table.entityType} IN ('event', 'product', 'feed_post')`,
    ),
    check('custom_card_packages_source_size_check', sql`${table.sourceSizeBytes} > 0`),
    check('custom_card_packages_uncompressed_size_check', sql`${table.totalUncompressedBytes} > 0`),
  ],
);

export const pointFundAccess = pgTable(
  'point_fund_access',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canCredit: boolean('can_credit').notNull().default(false),
    canDebit: boolean('can_debit').notNull().default(false),
    canView: boolean('can_view').notNull().default(true),
    grantedBy: uuid('granted_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('point_fund_access_program_user_uq').on(table.programId, table.userId),
    check(
      'point_fund_access_permission_check',
      sql`${table.canCredit} = true OR ${table.canDebit} = true OR ${table.canView} = true`,
    ),
  ],
);

export const coworkingBookings = pgTable(
  'coworking_bookings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    attendees: integer('attendees').notNull(),
    purpose: text('purpose').notNull(),
    status: text('status')
      .$type<'pending' | 'confirmed' | 'rejected' | 'cancelled'>()
      .notNull()
      .default('pending'),
    adminNote: text('admin_note'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('coworking_booking_user_key_uq').on(table.userId, table.idempotencyKey),
    index('coworking_booking_user_idx').on(table.userId, table.createdAt),
    index('coworking_booking_status_idx').on(table.status, table.createdAt),
    check(
      'coworking_booking_status_check',
      sql`${table.status} IN ('pending','confirmed','rejected','cancelled')`,
    ),
    check('coworking_booking_attendees_check', sql`${table.attendees} BETWEEN 1 AND 20`),
    check(
      'coworking_booking_duration_check',
      sql`${table.endsAt} >= ${table.startsAt} + interval '30 minutes' AND ${table.endsAt} <= ${table.startsAt} + interval '8 hours'`,
    ),
  ],
);

export const walletResetJobs = pgTable(
  'wallet_reset_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id')
      .notNull()
      .references(() => pointPrograms.id, { onDelete: 'restrict' }),
    fromSeasonId: uuid('from_season_id')
      .notNull()
      .references(() => pointSeasons.id, { onDelete: 'restrict' }),
    toSeasonId: uuid('to_season_id').references(() => pointSeasons.id, {
      onDelete: 'restrict',
    }),
    status: walletResetStatusEnum('status').notNull().default('draft'),
    targetOpeningAmount: bigint('target_opening_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    affectedAccounts: integer('affected_accounts'),
    previousTotal: bigint('previous_total', { mode: 'bigint' }),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    confirmedBy: uuid('confirmed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    previewedAt: timestamp('previewed_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('wallet_reset_jobs_program_idempotency_uq').on(
      table.programId,
      table.idempotencyKey,
    ),
    index('wallet_reset_jobs_program_created_idx').on(table.programId, table.createdAt),
    check('wallet_reset_jobs_target_nonnegative_check', sql`${table.targetOpeningAmount} >= 0`),
    check(
      'wallet_reset_jobs_counts_check',
      sql`${table.affectedAccounts} IS NULL OR ${table.affectedAccounts} >= 0`,
    ),
  ],
);
