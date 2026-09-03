import { randomUUID } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '@cpi/db';
import {
  eventArtifactFields,
  eventFormVersions,
  events,
  feedPosts,
  inventoryMovements,
  ledgerEntries,
  ledgerTransactions,
  outboxEvents,
  qrSessions,
  storeCategories,
  storeOrderItems,
  storeOrders,
  storeProductMedia,
  storeProductInventory,
  storeProducts,
  users,
  walletAccounts,
} from '@cpi/db';
import { AppError, publicStorageUrl } from '@cpi/shared';
import { writeAudit } from '../audit';
import {
  assertFeedCoverHead,
  assertFeedCoverSignature,
  deleteFeedCoverObject,
  FEED_COVER_MAX_SIZE_BYTES,
  FEED_COVER_UPLOAD_TTL_SECONDS,
  feedCoverContentTypes,
  feedCoverObjectKey,
  feedCoverPutHeaders,
  feedCoverUploadMetadata,
  isMissingFeedCoverObject,
  serializeFeedCoverUrl,
} from '../feed-cover';
import {
  assertProductMediaHead,
  assertProductMediaSignature,
  deleteProductMediaObject,
  isMissingProductMediaObject,
  PRODUCT_MEDIA_MAX_SIZE_BYTES,
  PRODUCT_MEDIA_UPLOAD_TTL_SECONDS,
  productImageContentTypes,
  productMediaObjectKey,
  productMediaPutHeaders,
  productMediaUploadMetadata,
  serializeReadyProductMedia,
  serializeReadyProductMediaList,
} from '../product-media';
import {
  hashQrSecret,
  isStoreOrderTransitionAllowed,
  requireIdempotencyKey,
  serializePoints,
} from '../wallet-domain';
import { loadActiveWalletContext } from '../wallet-service';
import { sanitizeRichContent, sanitizeRichHtml } from '../rich-content';
import { assertFeedActionSelection, isSafeFeedActionUrl } from '../feed-action';

const uuidParams = z.object({ id: z.uuid() });
const mediaParams = z.object({ id: z.uuid(), mediaId: z.uuid() });
const PRODUCT_MEDIA_MAX_ITEMS = 20;
const eventParams = z.object({ eventId: z.uuid() });
const formParams = z.object({ eventId: z.uuid(), formId: z.uuid() });
const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const transactionQuerySchema = listSchema.extend({
  kind: z
    .enum([
      'welcome_grant',
      'p2p_transfer',
      'staff_credit',
      'staff_debit',
      'artifact_reward',
      'store_purchase',
      'admin_adjustment',
      'season_opening',
      'reversal',
    ])
    .optional(),
  userId: z.uuid().optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});
const ADMIN_FILE_FIELD_KINDS = new Set(['file', 'image', 'document', 'audio', 'video', 'archive']);
const artifactFieldSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const source = input as Record<string, unknown>;
    const kind = typeof source.kind === 'string' ? source.kind : '';
    const fileField = ADMIN_FILE_FIELD_KINDS.has(kind);
    const config =
      source.config && typeof source.config === 'object' && !Array.isArray(source.config)
        ? { ...(source.config as Record<string, unknown>) }
        : {};
    if (!fileField) {
      if (typeof source.min === 'number') config.minLength = source.min;
      if (typeof source.max === 'number') config.maxLength = source.max;
    }
    return {
      ...source,
      code: source.code ?? source.key,
      minItems:
        source.minItems ?? (fileField && typeof source.min === 'number' ? source.min : undefined),
      maxItems:
        source.maxItems ?? (fileField && typeof source.max === 'number' ? source.max : undefined),
      config,
    };
  },
  z
    .object({
      code: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[a-z][a-z0-9_]*$/),
      kind: z.enum([
        'text',
        'checkbox',
        'link',
        'file',
        'image',
        'document',
        'audio',
        'video',
        'archive',
      ]),
      label: z.string().trim().min(1).max(300),
      description: z.string().trim().max(2_000).nullable().optional(),
      required: z.boolean().default(false),
      minItems: z.number().int().min(0).max(100).default(0),
      maxItems: z.number().int().min(1).max(100).default(1),
      allowedMimeTypes: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
      allowedExtensions: z
        .array(
          z
            .string()
            .trim()
            .regex(/^[a-zA-Z0-9]+$/)
            .max(20),
        )
        .max(100)
        .default([]),
      maxFileSizeBytes: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 ** 3)
        .nullable()
        .optional(),
      sortOrder: z.number().int().min(0).max(10_000).default(0),
      config: z.record(z.string(), z.unknown()).default({}),
    })
    .refine((value) => value.maxItems >= value.minItems, {
      message: 'maxItems должен быть не меньше minItems',
      path: ['maxItems'],
    }),
);
const formCreateSchema = z.object({
  title: z.string().trim().min(2).max(300),
  instructions: z.string().trim().max(10_000).nullable().optional(),
  submitButtonLabel: z.string().trim().min(1).max(100).default('Отправить'),
  status: z.enum(['draft', 'published']).default('draft'),
  fields: z
    .array(artifactFieldSchema)
    .min(1)
    .max(100)
    .superRefine((fields, context) => {
      const codes = new Set<string>();
      for (const [index, field] of fields.entries()) {
        if (codes.has(field.code)) {
          context.addIssue({ code: 'custom', path: [index, 'code'], message: 'Код повторяется' });
        }
        codes.add(field.code);
      }
    }),
});

const decimalPointInput = z
  .union([
    z.number().int(),
    z
      .string()
      .trim()
      .regex(/^\d{1,10}$/),
  ])
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n && value <= 1_000_000_000n, {
    message: 'Цена должна быть от 1 до 1000000000',
  });
const productFieldsSchema = z.object({
  categoryId: z.uuid().nullable().optional(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(50_000).nullable().optional(),
  descriptionFormat: z.enum(['text', 'html']).optional(),
  cardHtml: z.string().trim().max(100_000).nullable().optional(),
  kind: z.enum(['physical', 'digital']).default('physical'),
  status: z.enum(['draft', 'published', 'paused', 'archived']).default('draft'),
  price: decimalPointInput,
  stockMode: z.enum(['limited', 'unlimited']).default('limited'),
  perUserLimit: z.number().int().positive().max(10_000).nullable().optional(),
  availableFrom: z.iso.datetime({ offset: true }).nullable().optional(),
  availableUntil: z.iso.datetime({ offset: true }).nullable().optional(),
  pickupInstructions: z.string().trim().max(2_000).nullable().optional(),
  coverUrl: z.url().max(2_000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});
const productCreateSchema = productFieldsSchema.superRefine((value, context) => {
  if (
    value.availableFrom &&
    value.availableUntil &&
    new Date(value.availableUntil) < new Date(value.availableFrom)
  ) {
    context.addIssue({ code: 'custom', path: ['availableUntil'], message: 'Некорректный период' });
  }
});
const productUpdateSchema = productFieldsSchema.partial();
const inventorySchema = z.object({
  quantity: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(500),
});
const productMediaSchema = z.object({
  url: z.url().max(2_000),
  altText: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});
const productMediaUploadInitSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !value.includes('/') && !value.includes('\\'), {
      message: 'Имя файла не должно содержать путь',
    }),
  contentType: z.enum(productImageContentTypes),
  sizeBytes: z.number().int().positive().max(PRODUCT_MEDIA_MAX_SIZE_BYTES),
  altText: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});
const mediaReorderSchema = z.object({
  items: z
    .array(z.object({ id: z.uuid(), sortOrder: z.number().int().min(0).max(100_000) }))
    .min(1)
    .max(100),
});
const categorySchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
  active: z.boolean().default(true),
});
const orderQuerySchema = z.object({
  status: z.enum(['paid', 'pickup_requested', 'ready_for_pickup', 'fulfilled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const orderStatusSchema = z.object({ status: z.enum(['ready_for_pickup', 'fulfilled']) });
const pickupResolveSchema = z.object({
  token: z
    .string()
    .trim()
    .min(40)
    .max(160)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const safeFeedActionUrlSchema = z
  .string()
  .trim()
  .max(2_000)
  .refine(isSafeFeedActionUrl, 'CTA должна быть полной http(s)-ссылкой без логина и пароля');
const feedFieldsSchema = z.object({
  kind: z.enum(['news', 'event', 'product', 'system']).default('news'),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  audience: z.enum(['all', 'participants', 'admins']).default('all'),
  title: z.string().trim().min(2).max(300),
  summary: z.string().trim().max(1_000).nullable().optional(),
  body: z.string().trim().min(1).max(50_000).optional(),
  bodyFormat: z.enum(['text', 'html']).optional(),
  cardHtml: z.string().trim().max(100_000).nullable().optional(),
  coverUrl: z.url().max(2_000).nullable().optional(),
  ctaLabel: z.string().trim().max(100).nullable().optional(),
  ctaUrl: safeFeedActionUrlSchema.nullable().optional(),
  eventId: z.uuid().nullable().optional(),
  productId: z.uuid().nullable().optional(),
  pinned: z.boolean().default(false),
  publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const feedCoverUploadInitSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !value.includes('/') && !value.includes('\\'), {
      message: 'Имя файла не должно содержать путь',
    }),
  contentType: z.enum(feedCoverContentTypes),
  sizeBytes: z.number().int().positive().max(FEED_COVER_MAX_SIZE_BYTES),
});
const feedCoverCompleteSchema = z.object({
  uploadId: z.uuid(),
  contentType: z.enum(feedCoverContentTypes),
  sizeBytes: z.number().int().positive().max(FEED_COVER_MAX_SIZE_BYTES),
});

async function serializeAdminFeedPost(
  app: Parameters<FastifyPluginAsync>[0],
  post: typeof feedPosts.$inferSelect,
) {
  const { coverBucket, coverObjectKey, coverContentType, coverSizeBytes, ...publicPost } = post;
  void coverSizeBytes;
  return {
    ...publicPost,
    body: sanitizeRichContent(post.body, post.bodyFormat),
    cardHtml: post.cardHtml ? sanitizeRichHtml(post.cardHtml) : null,
    coverUrl: await serializeFeedCoverUrl(app.s3, app.config, {
      coverUrl: post.coverUrl,
      coverBucket,
      coverObjectKey,
      coverContentType,
    }),
    coverStoredInS3: Boolean(coverBucket && coverObjectKey),
  };
}

async function loadForm(app: Parameters<FastifyPluginAsync>[0], formId: string) {
  const [form] = await app.db
    .select()
    .from(eventFormVersions)
    .where(eq(eventFormVersions.id, formId))
    .limit(1);
  if (!form) throw new AppError('EVENT_FORM_NOT_FOUND', 'Форма не найдена', 404);
  const fields = await app.db
    .select()
    .from(eventArtifactFields)
    .where(eq(eventArtifactFields.formVersionId, form.id))
    .orderBy(asc(eventArtifactFields.sortOrder), asc(eventArtifactFields.id));
  return { ...form, fields };
}

async function createFormVersion(
  app: Parameters<FastifyPluginAsync>[0],
  eventId: string,
  actorUserId: string,
  body: z.infer<typeof formCreateSchema>,
): Promise<string> {
  return app.db.transaction(async (transaction) => {
    const [lockedEvent] = await transaction
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
      .for('update')
      .limit(1);
    if (!lockedEvent) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
    const [latest] = await transaction
      .select({ version: eventFormVersions.version })
      .from(eventFormVersions)
      .where(eq(eventFormVersions.eventId, eventId))
      .orderBy(desc(eventFormVersions.version))
      .limit(1);
    if (body.status === 'published') {
      await transaction
        .update(eventFormVersions)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(
          and(eq(eventFormVersions.eventId, eventId), eq(eventFormVersions.status, 'published')),
        );
    }
    const [form] = await transaction
      .insert(eventFormVersions)
      .values({
        eventId,
        version: (latest?.version ?? 0) + 1,
        title: body.title,
        instructions: body.instructions ?? null,
        submitButtonLabel: body.submitButtonLabel,
        status: body.status,
        publishedAt: body.status === 'published' ? new Date() : null,
        createdBy: actorUserId,
      })
      .returning({ id: eventFormVersions.id });
    if (!form) throw new Error('Form insert returned no row');
    await transaction.insert(eventArtifactFields).values(
      body.fields.map((field) => ({
        formVersionId: form.id,
        ...field,
        description: field.description ?? null,
        maxFileSizeBytes: field.maxFileSizeBytes ?? null,
      })),
    );
    if (body.status === 'published') {
      await transaction
        .update(events)
        .set({ activeFormVersionId: form.id, updatedAt: new Date(), updatedBy: actorUserId })
        .where(eq(events.id, eventId));
    }
    return form.id;
  });
}

function productValues(
  body: z.infer<typeof productCreateSchema>,
  actorUserId: string,
): typeof storeProducts.$inferInsert {
  return {
    categoryId: body.categoryId ?? null,
    slug: body.slug,
    title: body.title,
    description: body.description
      ? sanitizeRichContent(body.description, body.descriptionFormat ?? 'text')
      : null,
    descriptionFormat: body.descriptionFormat ?? 'text',
    cardHtml: body.cardHtml ? sanitizeRichHtml(body.cardHtml) : null,
    kind: body.kind,
    status: body.status,
    price: body.price,
    stockMode: body.stockMode,
    perUserLimit: body.perUserLimit ?? null,
    availableFrom: body.availableFrom ? new Date(body.availableFrom) : null,
    availableUntil: body.availableUntil ? new Date(body.availableUntil) : null,
    pickupInstructions: body.pickupInstructions ?? null,
    coverUrl: body.coverUrl ?? null,
    sortOrder: body.sortOrder,
    createdBy: actorUserId,
    updatedBy: actorUserId,
  };
}

function serializeProduct(product: typeof storeProducts.$inferSelect) {
  return {
    ...product,
    description: product.description
      ? sanitizeRichContent(product.description, product.descriptionFormat)
      : null,
    cardHtml: product.cardHtml ? sanitizeRichHtml(product.cardHtml) : null,
    price: serializePoints(product.price),
  };
}

function userDisplayName(user: typeof users.$inferSelect | null | undefined): string {
  if (!user) return 'Система';
  return (
    user.fullName ||
    [user.telegramFirstName, user.telegramLastName].filter(Boolean).join(' ') ||
    (user.telegramUsername ? `@${user.telegramUsername}` : '') ||
    'Участник'
  );
}

async function loadAdminOrderItems(
  database: Database,
  orderIds: string[],
): Promise<
  Map<
    string,
    Array<{
      productId: string;
      productTitle: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
    }>
  >
> {
  if (orderIds.length === 0) return new Map();
  const rows = await database
    .select()
    .from(storeOrderItems)
    .where(inArray(storeOrderItems.orderId, orderIds))
    .orderBy(asc(storeOrderItems.createdAt), asc(storeOrderItems.productId));
  const grouped = new Map<
    string,
    Array<{
      productId: string;
      productTitle: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
    }>
  >();
  for (const item of rows) {
    const serialized = {
      productId: item.productId,
      productTitle: item.titleSnapshot,
      quantity: item.quantity,
      unitPrice: serializePoints(item.unitPrice),
      lineTotal: serializePoints(item.lineTotal),
    };
    const current = grouped.get(item.orderId);
    if (current) current.push(serialized);
    else grouped.set(item.orderId, [serialized]);
  }
  return grouped;
}

function serializeAdminOrder(
  order: typeof storeOrders.$inferSelect,
  items: Awaited<ReturnType<typeof loadAdminOrderItems>> extends Map<string, infer T> ? T : never,
  user?: typeof users.$inferSelect,
) {
  const first = items[0];
  return {
    ...order,
    totalPoints: serializePoints(order.totalPoints),
    amount: serializePoints(order.totalPoints),
    productId: first?.productId ?? '',
    productTitle:
      items.length <= 1
        ? (first?.productTitle ?? 'Товар')
        : `${first?.productTitle ?? 'Товар'} +${items.length - 1}`,
    items,
    userName: user ? userDisplayName(user) : undefined,
    user: user
      ? {
          id: user.id,
          displayName: userDisplayName(user),
          username: user.telegramUsername,
        }
      : undefined,
  };
}

async function transitionOrderInTransaction(
  transaction: Database,
  orderId: string,
  target: 'ready_for_pickup' | 'fulfilled',
  actorUserId: string,
) {
  const [order] = await transaction
    .select()
    .from(storeOrders)
    .where(eq(storeOrders.id, orderId))
    .for('update')
    .limit(1);
  if (!order) throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', 404);
  if (order.status === target) return order;
  if (!isStoreOrderTransitionAllowed(order.status, target)) {
    throw new AppError(
      'ORDER_TRANSITION_INVALID',
      `Нельзя перевести заказ из ${order.status}`,
      409,
    );
  }
  const now = new Date();
  if (target === 'fulfilled') {
    // Fulfil only items which were actually reserved at checkout. A product may have an
    // inventory row even when it was sold in unlimited mode, and its current stockMode can be
    // changed later; neither is evidence that this order owns a reservation.
    const reservedProducts = await transaction
      .select({ productId: inventoryMovements.productId })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.orderId, order.id), eq(inventoryMovements.kind, 'reserve')));
    const reservedProductIds = reservedProducts.map((row) => row.productId);
    const items =
      reservedProductIds.length === 0
        ? []
        : await transaction
            .select({ item: storeOrderItems, inventory: storeProductInventory })
            .from(storeOrderItems)
            .innerJoin(
              storeProductInventory,
              eq(storeProductInventory.productId, storeOrderItems.productId),
            )
            .where(
              and(
                eq(storeOrderItems.orderId, order.id),
                inArray(storeOrderItems.productId, reservedProductIds),
              ),
            )
            .orderBy(asc(storeOrderItems.productId))
            .for('update');
    for (const { item, inventory } of items) {
      if (inventory.reserved < item.quantity || inventory.onHand < item.quantity) {
        throw new AppError('INVENTORY_INCONSISTENT', 'Резерв товара повреждён', 409);
      }
      const onHandAfter = inventory.onHand - item.quantity;
      const reservedAfter = inventory.reserved - item.quantity;
      await transaction
        .update(storeProductInventory)
        .set({
          onHand: onHandAfter,
          reserved: reservedAfter,
          version: sql`${storeProductInventory.version} + 1`,
          updatedAt: now,
        })
        .where(eq(storeProductInventory.productId, item.productId));
      await transaction.insert(inventoryMovements).values({
        productId: item.productId,
        orderId: order.id,
        kind: 'fulfill',
        quantity: -item.quantity,
        onHandAfter,
        reservedAfter,
        idempotencyKey: `fulfill:${order.id}:${item.productId}`,
        reason: 'Выдача заказа',
        actorUserId,
      });
    }
  }
  const [updated] = await transaction
    .update(storeOrders)
    .set(
      target === 'ready_for_pickup'
        ? { status: target, readyAt: now }
        : { status: target, fulfilledAt: now, fulfilledBy: actorUserId },
    )
    .where(eq(storeOrders.id, order.id))
    .returning();
  if (!updated) throw new Error('Order disappeared');
  await transaction
    .insert(outboxEvents)
    .values({
      type: `store.order.${target}`,
      aggregateType: 'store_order',
      aggregateId: order.id,
      payload: { orderId: order.id, userId: order.userId, status: target },
    })
    .onConflictDoNothing();
  return updated;
}

async function transitionOrder(
  app: Parameters<FastifyPluginAsync>[0],
  orderId: string,
  target: 'ready_for_pickup' | 'fulfilled',
  actorUserId: string,
) {
  return app.db.transaction((transaction) =>
    transitionOrderInTransaction(transaction as unknown as Database, orderId, target, actorUserId),
  );
}

export const adminContentRoutes: FastifyPluginAsync = async (app) => {
  const readGuards = [app.requireAuth, app.requireAdmin];
  const writeGuards = [app.requireAuth, app.requireCsrf, app.requireAdmin];

  app.get('/admin/wallet/accounts', { preHandler: readGuards }, async (request) => {
    const query = listSchema.parse(request.query);
    const { season } = await loadActiveWalletContext(app.db);
    const conditions = [
      eq(walletAccounts.seasonId, season.id),
      eq(walletAccounts.ownerKind, 'user'),
    ];
    if (query.q) {
      conditions.push(
        or(
          ilike(users.fullName, `%${query.q}%`),
          ilike(users.telegramUsername, `%${query.q}%`),
          ilike(walletAccounts.title, `%${query.q}%`),
        )!,
      );
    }
    const rows = await app.db
      .select({ account: walletAccounts, user: users })
      .from(walletAccounts)
      .leftJoin(users, eq(users.id, walletAccounts.userId))
      .where(and(...conditions))
      .orderBy(desc(walletAccounts.balance), asc(walletAccounts.id))
      .limit(query.limit);
    return {
      items: rows.map(({ account, user }) => ({
        id: account.id,
        userId: account.userId!,
        displayName: userDisplayName(user),
        telegramUsername: user?.telegramUsername ?? null,
        balance: serializePoints(account.balance),
        status: account.status,
        updatedAt: account.updatedAt,
      })),
    };
  });

  app.get('/admin/wallet/transactions', { preHandler: readGuards }, async (request) => {
    const query = transactionQuerySchema.parse(request.query);
    const { program } = await loadActiveWalletContext(app.db);
    const conditions = [eq(ledgerTransactions.programId, program.id)];
    if (query.kind) conditions.push(eq(ledgerTransactions.kind, query.kind));
    if (query.userId) conditions.push(eq(ledgerTransactions.subjectUserId, query.userId));
    if (query.before) conditions.push(lt(ledgerTransactions.createdAt, new Date(query.before)));
    const rows = await app.db
      .select()
      .from(ledgerTransactions)
      .where(and(...conditions))
      .orderBy(desc(ledgerTransactions.createdAt), desc(ledgerTransactions.id))
      .limit(query.limit);
    const ids = rows.map((transaction) => transaction.id);
    const entries =
      ids.length === 0
        ? []
        : await app.db
            .select({ entry: ledgerEntries, account: walletAccounts })
            .from(ledgerEntries)
            .innerJoin(walletAccounts, eq(walletAccounts.id, ledgerEntries.accountId))
            .where(inArray(ledgerEntries.transactionId, ids));
    const identityIds = [
      ...new Set(
        rows.flatMap((transaction) =>
          [transaction.subjectUserId, transaction.actorUserId].filter((id): id is string =>
            Boolean(id),
          ),
        ),
      ),
    ];
    const identities =
      identityIds.length === 0
        ? []
        : await app.db.select().from(users).where(inArray(users.id, identityIds));
    const identityById = new Map(identities.map((user) => [user.id, user]));
    return {
      items: rows.map((transaction) => {
        const transactionEntries = entries.filter(
          ({ entry }) => entry.transactionId === transaction.id,
        );
        const subjectEntry =
          transactionEntries.find(({ account }) => account.userId === transaction.subjectUserId) ??
          transactionEntries.find(({ account }) => account.ownerKind === 'user');
        const delta = subjectEntry?.entry.delta ?? 0n;
        return {
          id: transaction.id,
          kind: transaction.kind,
          amount: serializePoints(delta < 0n ? -delta : delta),
          direction: delta < 0n ? ('debit' as const) : ('credit' as const),
          userName: userDisplayName(
            transaction.subjectUserId ? identityById.get(transaction.subjectUserId) : undefined,
          ),
          actorName: transaction.actorUserId
            ? userDisplayName(identityById.get(transaction.actorUserId))
            : null,
          reason: transaction.reason,
          createdAt: transaction.createdAt,
          eventId: transaction.eventId,
          orderId: transaction.relatedOrderId,
          entries: transactionEntries.map(({ entry, account }) => ({
            id: entry.id,
            accountId: account.id,
            accountTitle: account.title,
            delta: serializePoints(entry.delta),
            balanceAfter: serializePoints(entry.balanceAfter),
          })),
        };
      }),
    };
  });

  app.get('/events/:eventId/form', { preHandler: app.requireAuth }, async (request) => {
    const { eventId } = eventParams.parse(request.params);
    const [event] = await app.db
      .select({ formId: events.activeFormVersionId })
      .from(events)
      .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
      .limit(1);
    if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
    return event.formId ? loadForm(app, event.formId) : null;
  });

  app.get('/events/:eventId/artifact-form', { preHandler: app.requireAuth }, async (request) => {
    const { eventId } = eventParams.parse(request.params);
    const [event] = await app.db
      .select({ formId: events.activeFormVersionId })
      .from(events)
      .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
      .limit(1);
    if (!event) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
    return event.formId ? loadForm(app, event.formId) : null;
  });

  app.get('/admin/events/:eventId/forms', { preHandler: readGuards }, async (request) => {
    const { eventId } = eventParams.parse(request.params);
    const forms = await app.db
      .select({ id: eventFormVersions.id })
      .from(eventFormVersions)
      .where(eq(eventFormVersions.eventId, eventId))
      .orderBy(desc(eventFormVersions.version));
    return { items: await Promise.all(forms.map((form) => loadForm(app, form.id))) };
  });

  app.get(
    '/admin/events/:eventId/artifact-form/versions',
    { preHandler: readGuards },
    async (request) => {
      const { eventId } = eventParams.parse(request.params);
      const forms = await app.db
        .select({ id: eventFormVersions.id })
        .from(eventFormVersions)
        .where(eq(eventFormVersions.eventId, eventId))
        .orderBy(desc(eventFormVersions.version));
      return { items: await Promise.all(forms.map((form) => loadForm(app, form.id))) };
    },
  );

  app.post('/admin/events/:eventId/forms', { preHandler: writeGuards }, async (request, reply) => {
    const { eventId } = eventParams.parse(request.params);
    const body = formCreateSchema.parse(request.body);
    const formId = await createFormVersion(app, eventId, request.currentUser!.id, body);
    await writeAudit(request, {
      action: 'event.form.create',
      entityType: 'event_form_version',
      entityId: formId,
      eventId,
    });
    return reply.code(201).send(await loadForm(app, formId));
  });

  // Compatibility name used by the first admin builder. It has the same validated contract;
  // `key/min/max/status` are normalized server-side, while the canonical API remains `/forms`.
  app.post(
    '/admin/events/:eventId/artifact-form/versions',
    { preHandler: writeGuards },
    async (request, reply) => {
      const { eventId } = eventParams.parse(request.params);
      const body = formCreateSchema.parse(request.body);
      const formId = await createFormVersion(app, eventId, request.currentUser!.id, body);
      await writeAudit(request, {
        action: 'event.form.create',
        entityType: 'event_form_version',
        entityId: formId,
        eventId,
      });
      return reply.code(201).send(await loadForm(app, formId));
    },
  );

  app.put('/admin/events/:eventId/forms/:formId', { preHandler: writeGuards }, async (request) => {
    const { eventId, formId } = formParams.parse(request.params);
    const body = formCreateSchema.parse(request.body);
    await app.db.transaction(async (transaction) => {
      const [form] = await transaction
        .select()
        .from(eventFormVersions)
        .where(and(eq(eventFormVersions.id, formId), eq(eventFormVersions.eventId, eventId)))
        .for('update')
        .limit(1);
      if (!form) throw new AppError('EVENT_FORM_NOT_FOUND', 'Форма не найдена', 404);
      if (form.status !== 'draft')
        throw new AppError('EVENT_FORM_IMMUTABLE', 'Опубликованную форму нельзя менять', 409);
      await transaction
        .update(eventFormVersions)
        .set({
          title: body.title,
          instructions: body.instructions ?? null,
          submitButtonLabel: body.submitButtonLabel,
          updatedAt: new Date(),
        })
        .where(eq(eventFormVersions.id, form.id));
      await transaction
        .delete(eventArtifactFields)
        .where(eq(eventArtifactFields.formVersionId, form.id));
      await transaction.insert(eventArtifactFields).values(
        body.fields.map((field) => ({
          formVersionId: form.id,
          ...field,
          description: field.description ?? null,
          maxFileSizeBytes: field.maxFileSizeBytes ?? null,
        })),
      );
    });
    return loadForm(app, formId);
  });

  app.post(
    '/admin/events/:eventId/forms/:formId/publish',
    { preHandler: writeGuards },
    async (request) => {
      const { eventId, formId } = formParams.parse(request.params);
      await app.db.transaction(async (transaction) => {
        const [lockedEvent] = await transaction
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
          .for('update')
          .limit(1);
        if (!lockedEvent) throw new AppError('EVENT_NOT_FOUND', 'Мероприятие не найдено', 404);
        const [form] = await transaction
          .select()
          .from(eventFormVersions)
          .where(and(eq(eventFormVersions.id, formId), eq(eventFormVersions.eventId, eventId)))
          .for('update')
          .limit(1);
        if (!form) throw new AppError('EVENT_FORM_NOT_FOUND', 'Форма не найдена', 404);
        await transaction
          .update(eventFormVersions)
          .set({ status: 'archived', updatedAt: new Date() })
          .where(
            and(eq(eventFormVersions.eventId, eventId), eq(eventFormVersions.status, 'published')),
          );
        await transaction
          .update(eventFormVersions)
          .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
          .where(eq(eventFormVersions.id, form.id));
        await transaction
          .update(events)
          .set({
            activeFormVersionId: form.id,
            updatedAt: new Date(),
            updatedBy: request.currentUser!.id,
          })
          .where(eq(events.id, eventId));
      });
      await writeAudit(request, {
        action: 'event.form.publish',
        entityType: 'event_form_version',
        entityId: formId,
        eventId,
      });
      return loadForm(app, formId);
    },
  );

  app.get('/admin/store/categories', { preHandler: readGuards }, async () => ({
    items: await app.db
      .select()
      .from(storeCategories)
      .where(isNull(storeCategories.deletedAt))
      .orderBy(asc(storeCategories.sortOrder)),
  }));

  app.post('/admin/store/categories', { preHandler: writeGuards }, async (request, reply) => {
    const body = categorySchema.parse(request.body);
    const [category] = await app.db
      .insert(storeCategories)
      .values({
        ...body,
        description: body.description ?? null,
        createdBy: request.currentUser!.id,
        updatedBy: request.currentUser!.id,
      })
      .returning();
    if (!category) throw new Error('Category insert returned no row');
    return reply.code(201).send(category);
  });

  app.get('/admin/store/products', { preHandler: readGuards }, async (request) => {
    const query = listSchema.parse(request.query);
    const conditions = [isNull(storeProducts.deletedAt)];
    if (query.q)
      conditions.push(
        or(ilike(storeProducts.title, `%${query.q}%`), ilike(storeProducts.slug, `%${query.q}%`))!,
      );
    const rows = await app.db
      .select({
        product: storeProducts,
        inventory: storeProductInventory,
        category: storeCategories,
      })
      .from(storeProducts)
      .leftJoin(storeProductInventory, eq(storeProductInventory.productId, storeProducts.id))
      .leftJoin(storeCategories, eq(storeCategories.id, storeProducts.categoryId))
      .where(and(...conditions))
      .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.title))
      .limit(query.limit);
    const productIds = rows.map(({ product }) => product.id);
    const media =
      productIds.length === 0
        ? []
        : await app.db
            .select()
            .from(storeProductMedia)
            .where(inArray(storeProductMedia.productId, productIds))
            .orderBy(asc(storeProductMedia.sortOrder), asc(storeProductMedia.id));
    const serializedMedia = await serializeReadyProductMediaList(app.s3, app.config, media);
    return {
      items: rows.map(({ product, inventory, category }) => {
        const productMedia = serializedMedia.filter((item) => item.productId === product.id);
        return {
          ...serializeProduct(product),
          inventory,
          stock:
            product.stockMode === 'limited'
              ? Math.max(0, (inventory?.onHand ?? 0) - (inventory?.reserved ?? 0))
              : null,
          category,
          coverUrl: product.coverUrl ?? productMedia[0]?.url ?? null,
          media: productMedia,
        };
      }),
    };
  });

  app.post('/admin/store/products', { preHandler: writeGuards }, async (request, reply) => {
    const body = productCreateSchema.parse(request.body);
    if (body.status === 'published') {
      if (body.kind === 'digital') {
        throw new AppError(
          'DIGITAL_DELIVERY_NOT_AVAILABLE',
          'Цифровой товар можно сохранить как черновик, но его выдача ещё не настроена',
          409,
        );
      }
      const context = await loadActiveWalletContext(app.db);
      if (body.price > context.program.maxTransactionAmount) {
        throw new AppError(
          'PRODUCT_PRICE_EXCEEDS_PROGRAM_LIMIT',
          `Цена опубликованного товара не может превышать ${serializePoints(context.program.maxTransactionAmount)}`,
          409,
        );
      }
    }
    const [product] = await app.db
      .insert(storeProducts)
      .values(productValues(body, request.currentUser!.id))
      .returning();
    if (!product) throw new Error('Product insert returned no row');
    if (product.stockMode === 'limited')
      await app.db
        .insert(storeProductInventory)
        .values({ productId: product.id })
        .onConflictDoNothing();
    await writeAudit(request, {
      action: 'store.product.create',
      entityType: 'store_product',
      entityId: product.id,
    });
    return reply.code(201).send(serializeProduct(product));
  });

  app.patch('/admin/store/products/:id', { preHandler: writeGuards }, async (request) => {
    const { id } = uuidParams.parse(request.params);
    const body = productUpdateSchema.parse(request.body);
    const product = await app.db.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(storeProducts)
        .where(and(eq(storeProducts.id, id), isNull(storeProducts.deletedAt)))
        .for('update')
        .limit(1);
      if (!current) throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', 404);
      const availableFrom =
        body.availableFrom === undefined
          ? current.availableFrom
          : body.availableFrom
            ? new Date(body.availableFrom)
            : null;
      const availableUntil =
        body.availableUntil === undefined
          ? current.availableUntil
          : body.availableUntil
            ? new Date(body.availableUntil)
            : null;
      if (availableFrom && availableUntil && availableUntil < availableFrom) {
        throw new AppError('PRODUCT_AVAILABILITY_INVALID', 'Некорректный период доступности', 400);
      }
      const resultingStatus = body.status ?? current.status;
      const resultingPrice = body.price ?? current.price;
      const resultingKind = body.kind ?? current.kind;
      const resultingDescriptionFormat = body.descriptionFormat ?? current.descriptionFormat;
      const descriptionSource =
        body.description === undefined ? current.description : body.description;
      const resultingDescription = descriptionSource
        ? sanitizeRichContent(descriptionSource, resultingDescriptionFormat)
        : null;
      if (resultingStatus === 'published') {
        if (resultingKind === 'digital') {
          throw new AppError(
            'DIGITAL_DELIVERY_NOT_AVAILABLE',
            'Цифровой товар можно сохранить как черновик, но его выдача ещё не настроена',
            409,
          );
        }
        const context = await loadActiveWalletContext(transaction as unknown as Database);
        if (resultingPrice > context.program.maxTransactionAmount) {
          throw new AppError(
            'PRODUCT_PRICE_EXCEEDS_PROGRAM_LIMIT',
            `Цена опубликованного товара не может превышать ${serializePoints(context.program.maxTransactionAmount)}`,
            409,
          );
        }
      }
      const [updated] = await transaction
        .update(storeProducts)
        .set({
          ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
          ...(body.slug === undefined ? {} : { slug: body.slug }),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined && body.descriptionFormat === undefined
            ? {}
            : {
                description: resultingDescription,
                descriptionFormat: resultingDescriptionFormat,
              }),
          ...(body.cardHtml === undefined
            ? {}
            : { cardHtml: body.cardHtml ? sanitizeRichHtml(body.cardHtml) : null }),
          ...(body.kind === undefined ? {} : { kind: body.kind }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(body.price === undefined ? {} : { price: body.price }),
          ...(body.stockMode === undefined ? {} : { stockMode: body.stockMode }),
          ...(body.perUserLimit === undefined ? {} : { perUserLimit: body.perUserLimit }),
          ...(body.availableFrom === undefined ? {} : { availableFrom }),
          ...(body.availableUntil === undefined ? {} : { availableUntil }),
          ...(body.pickupInstructions === undefined
            ? {}
            : { pickupInstructions: body.pickupInstructions }),
          ...(body.coverUrl === undefined ? {} : { coverUrl: body.coverUrl }),
          ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
          updatedBy: request.currentUser!.id,
          updatedAt: new Date(),
        })
        .where(eq(storeProducts.id, id))
        .returning();
      if (!updated) throw new Error('Product update returned no row');
      return updated;
    });
    if (product.stockMode === 'limited')
      await app.db
        .insert(storeProductInventory)
        .values({ productId: product.id })
        .onConflictDoNothing();
    await writeAudit(request, {
      action: 'store.product.update',
      entityType: 'store_product',
      entityId: product.id,
      metadata: { changedFields: Object.keys(body) },
    });
    return serializeProduct(product);
  });

  app.post('/admin/store/products/:id/inventory', { preHandler: writeGuards }, async (request) => {
    const { id } = uuidParams.parse(request.params);
    const body = inventorySchema.parse(request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const movementKey = `inventory:${id}:${idempotencyKey}`;
    const inventory = await app.db.transaction(async (transaction) => {
      const [existingMovement] = await transaction
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.idempotencyKey, movementKey))
        .limit(1);
      if (existingMovement) {
        if (
          existingMovement.productId !== id ||
          existingMovement.quantity !== body.quantity ||
          existingMovement.reason !== body.reason
        ) {
          throw new AppError(
            'IDEMPOTENCY_KEY_REUSED',
            'Этот Idempotency-Key уже использован для другой операции',
            409,
          );
        }
        const [replayed] = await transaction
          .select()
          .from(storeProductInventory)
          .where(eq(storeProductInventory.productId, id))
          .limit(1);
        if (!replayed) throw new Error('Inventory replay row disappeared');
        return replayed;
      }
      const [product] = await transaction
        .select()
        .from(storeProducts)
        .where(eq(storeProducts.id, id))
        .limit(1);
      if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', 404);
      if (product.stockMode !== 'limited') {
        throw new AppError(
          'PRODUCT_STOCK_UNLIMITED',
          'Остаток не изменяется для товара без ограничения',
          409,
        );
      }
      await transaction
        .insert(storeProductInventory)
        .values({ productId: id })
        .onConflictDoNothing();
      const [current] = await transaction
        .select()
        .from(storeProductInventory)
        .where(eq(storeProductInventory.productId, id))
        .for('update')
        .limit(1);
      if (!current) throw new Error('Inventory disappeared');
      const onHandAfter = current.onHand + body.quantity;
      if (onHandAfter < current.reserved || onHandAfter < 0)
        throw new AppError('INVENTORY_BELOW_RESERVED', 'Остаток не может быть меньше резерва', 409);
      const [updated] = await transaction
        .update(storeProductInventory)
        .set({
          onHand: onHandAfter,
          version: sql`${storeProductInventory.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(storeProductInventory.productId, id))
        .returning();
      await transaction.insert(inventoryMovements).values({
        productId: id,
        kind: body.quantity > 0 ? 'restock' : 'adjustment',
        quantity: body.quantity,
        onHandAfter,
        reservedAfter: current.reserved,
        idempotencyKey: movementKey,
        reason: body.reason,
        actorUserId: request.currentUser!.id,
      });
      return updated!;
    });
    return inventory;
  });

  app.post(
    '/admin/store/products/:id/media',
    { preHandler: writeGuards },
    async (request, reply) => {
      const { id } = uuidParams.parse(request.params);
      const body = productMediaSchema.parse(request.body);
      const [product] = await app.db
        .select({ id: storeProducts.id })
        .from(storeProducts)
        .where(and(eq(storeProducts.id, id), isNull(storeProducts.deletedAt)))
        .limit(1);
      if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', 404);
      const [created] = await app.db
        .insert(storeProductMedia)
        .values({
          productId: id,
          url: body.url,
          altText: body.altText ?? null,
          sortOrder: body.sortOrder,
        })
        .returning();
      if (!created) throw new Error('Product media insert returned no row');
      await writeAudit(request, {
        action: 'store.product_media.create',
        entityType: 'store_product_media',
        entityId: created.id,
        metadata: { productId: id },
      });
      const serialized = await serializeReadyProductMedia(app.s3, app.config, created);
      if (!serialized) throw new Error('Legacy product media did not serialize');
      return reply.code(201).send(serialized);
    },
  );

  app.post(
    '/admin/store/products/:id/media/uploads',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = uuidParams.parse(request.params);
      const body = productMediaUploadInitSchema.parse(request.body);
      const [product] = await app.db
        .select({ id: storeProducts.id })
        .from(storeProducts)
        .where(and(eq(storeProducts.id, id), isNull(storeProducts.deletedAt)))
        .limit(1);
      if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', 404);
      const [countRow] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(storeProductMedia)
        .where(eq(storeProductMedia.productId, id));
      if ((countRow?.count ?? 0) >= PRODUCT_MEDIA_MAX_ITEMS) {
        throw new AppError(
          'PRODUCT_MEDIA_LIMIT',
          `У товара может быть не больше ${PRODUCT_MEDIA_MAX_ITEMS} изображений`,
          409,
        );
      }
      const mediaId = randomUUID();
      const objectKey = productMediaObjectKey(app.config.S3_PREFIX, id, mediaId, body.contentType);
      const uploadExpiresAt = new Date(Date.now() + PRODUCT_MEDIA_UPLOAD_TTL_SECONDS * 1_000);
      const metadata = productMediaUploadMetadata(mediaId, id, body.sizeBytes);
      const [created] = await app.db
        .insert(storeProductMedia)
        .values({
          id: mediaId,
          productId: id,
          url: null,
          bucket: app.config.S3_BUCKET,
          objectKey,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
          uploadStatus: 'pending',
          uploadExpiresAt,
          altText: body.altText ?? null,
          sortOrder: body.sortOrder,
        })
        .returning();
      if (!created) throw new Error('Product media upload insert returned no row');
      const uploadUrl = publicStorageUrl(
        await getSignedUrl(
          app.s3,
          new PutObjectCommand({
            Bucket: created.bucket!,
            Key: created.objectKey!,
            ContentType: created.contentType!,
            Metadata: metadata,
          }),
          { expiresIn: PRODUCT_MEDIA_UPLOAD_TTL_SECONDS },
        ),
        app.config.S3_PUBLIC_BASE,
      );
      await writeAudit(request, {
        action: 'store.product_media.upload.init',
        entityType: 'store_product_media',
        entityId: created.id,
        metadata: { productId: id, sizeBytes: body.sizeBytes, contentType: body.contentType },
      });
      return reply.code(201).send({
        mediaId: created.id,
        uploadUrl,
        method: 'PUT' as const,
        headers: productMediaPutHeaders(created.id, id, created.contentType!, created.sizeBytes!),
        expiresInSeconds: PRODUCT_MEDIA_UPLOAD_TTL_SECONDS,
      });
    },
  );

  app.post(
    '/admin/store/products/:id/media/:mediaId/complete',
    { preHandler: writeGuards },
    async (request) => {
      const { id, mediaId } = mediaParams.parse(request.params);
      const [media] = await app.db
        .select()
        .from(storeProductMedia)
        .where(and(eq(storeProductMedia.id, mediaId), eq(storeProductMedia.productId, id)))
        .limit(1);
      if (!media) throw new AppError('PRODUCT_MEDIA_NOT_FOUND', 'Изображение не найдено', 404);
      if (media.uploadStatus === 'ready') {
        const serialized = await serializeReadyProductMedia(app.s3, app.config, media);
        if (!serialized)
          throw new AppError('PRODUCT_MEDIA_NOT_FOUND', 'Изображение не найдено', 404);
        return serialized;
      }
      if (!media.bucket || !media.objectKey || !media.contentType || !media.sizeBytes) {
        throw new AppError('PRODUCT_MEDIA_NOT_FOUND', 'Изображение не найдено', 404);
      }
      if (!media.uploadExpiresAt || media.uploadExpiresAt <= new Date()) {
        await deleteProductMediaObject(app.s3, media);
        await app.db.delete(storeProductMedia).where(eq(storeProductMedia.id, media.id));
        throw new AppError(
          'PRODUCT_MEDIA_UPLOAD_EXPIRED',
          'Срок загрузки истёк, выберите файл ещё раз',
          410,
        );
      }
      const pending = {
        id: media.id,
        productId: media.productId,
        bucket: media.bucket,
        objectKey: media.objectKey,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        uploadExpiresAt: media.uploadExpiresAt,
      };
      try {
        const head = await app.s3.send(
          new HeadObjectCommand({
            Bucket: pending.bucket,
            Key: pending.objectKey,
          }),
        );
        assertProductMediaHead(pending, head);
        await assertProductMediaSignature(app.s3, pending);
      } catch (error) {
        if (error instanceof AppError) {
          await deleteProductMediaObject(app.s3, pending);
          await app.db.delete(storeProductMedia).where(eq(storeProductMedia.id, media.id));
          throw error;
        }
        if (isMissingProductMediaObject(error)) {
          throw new AppError('PRODUCT_MEDIA_NOT_UPLOADED', 'Файл ещё не появился в хранилище', 409);
        }
        throw error;
      }
      const [updated] = await app.db
        .update(storeProductMedia)
        .set({
          uploadStatus: 'ready',
          uploadExpiresAt: null,
        })
        .where(
          and(eq(storeProductMedia.id, media.id), eq(storeProductMedia.uploadStatus, 'pending')),
        )
        .returning();
      const ready = updated ?? media;
      await writeAudit(request, {
        action: 'store.product_media.upload.complete',
        entityType: 'store_product_media',
        entityId: ready.id,
        metadata: { productId: id },
      });
      const serialized = await serializeReadyProductMedia(app.s3, app.config, ready);
      if (!serialized) throw new Error('Completed product media did not serialize');
      return serialized;
    },
  );

  app.put(
    '/admin/store/products/:id/media/reorder',
    { preHandler: writeGuards },
    async (request) => {
      const { id } = uuidParams.parse(request.params);
      const body = mediaReorderSchema.parse(request.body);
      if (new Set(body.items.map((item) => item.id)).size !== body.items.length) {
        throw new AppError('PRODUCT_MEDIA_DUPLICATED', 'Изображение повторяется', 400);
      }
      const reordered = await app.db.transaction(async (transaction) => {
        const rows = await transaction
          .select()
          .from(storeProductMedia)
          .where(
            inArray(
              storeProductMedia.id,
              body.items.map((item) => item.id),
            ),
          )
          .orderBy(asc(storeProductMedia.id))
          .for('update');
        if (rows.length !== body.items.length || rows.some((row) => row.productId !== id)) {
          throw new AppError('PRODUCT_MEDIA_NOT_FOUND', 'Одно из изображений не найдено', 404);
        }
        for (const item of body.items) {
          await transaction
            .update(storeProductMedia)
            .set({ sortOrder: item.sortOrder })
            .where(eq(storeProductMedia.id, item.id));
        }
        return transaction
          .select()
          .from(storeProductMedia)
          .where(eq(storeProductMedia.productId, id))
          .orderBy(asc(storeProductMedia.sortOrder), asc(storeProductMedia.id));
      });
      return { items: reordered };
    },
  );

  app.delete(
    '/admin/store/products/:id/media/:mediaId',
    { preHandler: writeGuards },
    async (request, reply) => {
      const { id, mediaId } = mediaParams.parse(request.params);
      const [media] = await app.db
        .select()
        .from(storeProductMedia)
        .where(and(eq(storeProductMedia.id, mediaId), eq(storeProductMedia.productId, id)))
        .limit(1);
      if (!media) throw new AppError('PRODUCT_MEDIA_NOT_FOUND', 'Изображение не найдено', 404);
      try {
        await deleteProductMediaObject(app.s3, media);
      } catch {
        throw new AppError(
          'PRODUCT_MEDIA_DELETE_FAILED',
          'Не удалось удалить файл из хранилища',
          502,
        );
      }
      const [deleted] = await app.db
        .delete(storeProductMedia)
        .where(and(eq(storeProductMedia.id, mediaId), eq(storeProductMedia.productId, id)))
        .returning({ id: storeProductMedia.id });
      if (!deleted) throw new AppError('PRODUCT_MEDIA_NOT_FOUND', 'Изображение не найдено', 404);
      await writeAudit(request, {
        action: 'store.product_media.delete',
        entityType: 'store_product_media',
        entityId: mediaId,
        metadata: { productId: id, objectKey: media.objectKey },
      });
      return reply.code(204).send();
    },
  );

  app.get('/admin/store/orders', { preHandler: readGuards }, async (request) => {
    const query = orderQuerySchema.parse(request.query);
    const orders = await app.db
      .select({ order: storeOrders, user: users })
      .from(storeOrders)
      .innerJoin(users, eq(users.id, storeOrders.userId))
      .where(query.status ? eq(storeOrders.status, query.status) : undefined)
      .orderBy(desc(storeOrders.createdAt))
      .limit(query.limit);
    const itemsByOrder = await loadAdminOrderItems(
      app.db,
      orders.map(({ order }) => order.id),
    );
    return {
      items: orders.map(({ order, user }) =>
        serializeAdminOrder(order, itemsByOrder.get(order.id) ?? [], user),
      ),
    };
  });

  app.patch('/admin/store/orders/:id/status', { preHandler: writeGuards }, async (request) => {
    const { id } = uuidParams.parse(request.params);
    const body = orderStatusSchema.parse(request.body);
    const order = await transitionOrder(app, id, body.status, request.currentUser!.id);
    await writeAudit(request, {
      action: `store.order.${body.status}`,
      entityType: 'store_order',
      entityId: order.id,
    });
    const items = await loadAdminOrderItems(app.db, [order.id]);
    return serializeAdminOrder(order, items.get(order.id) ?? []);
  });

  app.post('/admin/store/orders/resolve-pickup', { preHandler: writeGuards }, async (request) => {
    const body = pickupResolveSchema.parse(request.body);
    const tokenHash = hashQrSecret(body.token);
    const order = await app.db.transaction(async (transaction) => {
      const database = transaction as unknown as Database;
      const [session] = await database
        .select()
        .from(qrSessions)
        .where(eq(qrSessions.tokenHash, tokenHash))
        .for('update')
        .limit(1);
      if (!session || session.purpose !== 'order_pickup' || !session.orderId) {
        throw new AppError('PICKUP_QR_NOT_FOUND', 'QR заказа не найден', 404);
      }
      if (session.status !== 'active' || session.expiresAt <= new Date()) {
        throw new AppError('PICKUP_QR_EXPIRED', 'QR заказа истёк', 409);
      }
      const [current] = await database
        .select({ status: storeOrders.status })
        .from(storeOrders)
        .where(eq(storeOrders.id, session.orderId))
        .limit(1);
      if (!current) throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', 404);
      if (current.status === 'pickup_requested') {
        await transitionOrderInTransaction(
          database,
          session.orderId,
          'ready_for_pickup',
          request.currentUser!.id,
        );
      }
      const fulfilled = await transitionOrderInTransaction(
        database,
        session.orderId,
        'fulfilled',
        request.currentUser!.id,
      );
      const [consumed] = await database
        .update(qrSessions)
        .set({
          status: 'consumed',
          claimedByUserId: request.currentUser!.id,
          claimedAt: new Date(),
          consumedAt: new Date(),
        })
        .where(and(eq(qrSessions.id, session.id), eq(qrSessions.status, 'active')))
        .returning({ id: qrSessions.id });
      if (!consumed) throw new AppError('PICKUP_QR_EXPIRED', 'QR уже использован', 409);
      return fulfilled;
    });
    const items = await loadAdminOrderItems(app.db, [order.id]);
    return serializeAdminOrder(order, items.get(order.id) ?? []);
  });

  app.get('/admin/feed', { preHandler: readGuards }, async () => {
    const posts = await app.db
      .select()
      .from(feedPosts)
      .orderBy(desc(feedPosts.createdAt))
      .limit(200);
    return {
      items: await Promise.all(posts.map((post) => serializeAdminFeedPost(app, post))),
    };
  });

  app.post('/admin/feed', { preHandler: writeGuards }, async (request, reply) => {
    const body = feedFieldsSchema.parse(request.body);
    assertFeedActionSelection({
      ctaUrl: body.ctaUrl ?? null,
      eventId: body.eventId ?? null,
      productId: body.productId ?? null,
    });
    const bodyFormat = body.bodyFormat ?? 'text';
    const content = body.body ?? body.summary ?? body.title;
    const [post] = await app.db
      .insert(feedPosts)
      .values({
        ...body,
        body: sanitizeRichContent(content, bodyFormat),
        bodyFormat,
        cardHtml: body.cardHtml ? sanitizeRichHtml(body.cardHtml) : null,
        summary: body.summary ?? null,
        coverUrl: body.coverUrl ?? null,
        ctaLabel: body.ctaLabel ?? null,
        ctaUrl: body.ctaUrl ?? null,
        eventId: body.eventId ?? null,
        productId: body.productId ?? null,
        publishedAt:
          body.status === 'published'
            ? body.publishedAt
              ? new Date(body.publishedAt)
              : new Date()
            : body.publishedAt
              ? new Date(body.publishedAt)
              : null,
        createdBy: request.currentUser!.id,
        updatedBy: request.currentUser!.id,
      })
      .returning();
    if (!post) throw new Error('Feed post insert returned no row');
    return reply.code(201).send(await serializeAdminFeedPost(app, post));
  });

  app.patch('/admin/feed/:id', { preHandler: writeGuards }, async (request) => {
    const { id } = uuidParams.parse(request.params);
    const body = feedFieldsSchema.partial().parse(request.body);
    const {
      publishedAt,
      body: requestedBody,
      bodyFormat: requestedBodyFormat,
      cardHtml: requestedCardHtml,
      ...fields
    } = body;
    const result = await app.db.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(feedPosts)
        .where(eq(feedPosts.id, id))
        .for('update')
        .limit(1);
      if (!current) throw new AppError('FEED_POST_NOT_FOUND', 'Публикация не найдена', 404);
      assertFeedActionSelection({
        ctaUrl: body.ctaUrl === undefined ? current.ctaUrl : body.ctaUrl,
        eventId: body.eventId === undefined ? current.eventId : body.eventId,
        productId: body.productId === undefined ? current.productId : body.productId,
      });
      const resultingBodyFormat = requestedBodyFormat ?? current.bodyFormat;
      const resultingBody = sanitizeRichContent(requestedBody ?? current.body, resultingBodyFormat);
      const [post] = await transaction
        .update(feedPosts)
        .set({
          ...fields,
          ...(requestedBody === undefined && requestedBodyFormat === undefined
            ? {}
            : { body: resultingBody, bodyFormat: resultingBodyFormat }),
          ...(requestedCardHtml === undefined
            ? {}
            : {
                cardHtml: requestedCardHtml ? sanitizeRichHtml(requestedCardHtml) : null,
              }),
          ...(body.coverUrl === undefined
            ? {}
            : {
                coverUrl: body.coverUrl,
                coverBucket: null,
                coverObjectKey: null,
                coverContentType: null,
                coverSizeBytes: null,
              }),
          ...(publishedAt === undefined
            ? {}
            : { publishedAt: publishedAt ? new Date(publishedAt) : null }),
          ...(body.status === 'published' && publishedAt === undefined
            ? { publishedAt: new Date() }
            : {}),
          updatedBy: request.currentUser!.id,
          updatedAt: new Date(),
        })
        .where(eq(feedPosts.id, id))
        .returning();
      if (!post) throw new Error('Feed post disappeared during update');
      return { current, post };
    });
    if (body.coverUrl !== undefined && result.current.coverObjectKey) {
      await deleteFeedCoverObject(app.s3, result.current).catch((error) => {
        app.log.error({ error, postId: id }, 'Replaced feed cover cleanup failed');
      });
    }
    return serializeAdminFeedPost(app, result.post);
  });

  app.post(
    '/admin/feed/:id/cover/upload',
    {
      preHandler: writeGuards,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = uuidParams.parse(request.params);
      const body = feedCoverUploadInitSchema.parse(request.body);
      const [post] = await app.db
        .select({ id: feedPosts.id })
        .from(feedPosts)
        .where(eq(feedPosts.id, id))
        .limit(1);
      if (!post) throw new AppError('FEED_POST_NOT_FOUND', 'Публикация не найдена', 404);
      const uploadId = randomUUID();
      const objectKey = feedCoverObjectKey(app.config.S3_PREFIX, id, uploadId, body.contentType);
      const metadata = feedCoverUploadMetadata(uploadId, id, body.sizeBytes);
      const uploadUrl = publicStorageUrl(
        await getSignedUrl(
          app.s3,
          new PutObjectCommand({
            Bucket: app.config.S3_BUCKET,
            Key: objectKey,
            ContentType: body.contentType,
            Metadata: metadata,
          }),
          { expiresIn: FEED_COVER_UPLOAD_TTL_SECONDS },
        ),
        app.config.S3_PUBLIC_BASE,
      );
      await writeAudit(request, {
        action: 'feed.cover.upload.init',
        entityType: 'feed_post',
        entityId: id,
        metadata: {
          uploadId,
          sizeBytes: body.sizeBytes,
          contentType: body.contentType,
        },
      });
      return reply.code(201).send({
        uploadId,
        uploadUrl,
        method: 'PUT' as const,
        headers: feedCoverPutHeaders(uploadId, id, body.contentType, body.sizeBytes),
        expiresInSeconds: FEED_COVER_UPLOAD_TTL_SECONDS,
      });
    },
  );

  app.post('/admin/feed/:id/cover/complete', { preHandler: writeGuards }, async (request) => {
    const { id } = uuidParams.parse(request.params);
    const body = feedCoverCompleteSchema.parse(request.body);
    const [exists] = await app.db
      .select({ id: feedPosts.id })
      .from(feedPosts)
      .where(eq(feedPosts.id, id))
      .limit(1);
    if (!exists) throw new AppError('FEED_POST_NOT_FOUND', 'Публикация не найдена', 404);
    const pending = {
      uploadId: body.uploadId,
      postId: id,
      bucket: app.config.S3_BUCKET,
      objectKey: feedCoverObjectKey(app.config.S3_PREFIX, id, body.uploadId, body.contentType),
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    };
    try {
      const head = await app.s3.send(
        new HeadObjectCommand({
          Bucket: pending.bucket,
          Key: pending.objectKey,
        }),
      );
      assertFeedCoverHead(pending, head);
      await assertFeedCoverSignature(app.s3, pending);
    } catch (error) {
      if (error instanceof AppError) {
        await deleteFeedCoverObject(app.s3, {
          coverBucket: pending.bucket,
          coverObjectKey: pending.objectKey,
        });
        throw error;
      }
      if (isMissingFeedCoverObject(error)) {
        throw new AppError('FEED_COVER_NOT_UPLOADED', 'Обложка ещё не появилась в Beget S3', 409);
      }
      throw error;
    }
    const result = await app.db.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(feedPosts)
        .where(eq(feedPosts.id, id))
        .for('update')
        .limit(1);
      if (!current) throw new AppError('FEED_POST_NOT_FOUND', 'Публикация не найдена', 404);
      const [updated] = await transaction
        .update(feedPosts)
        .set({
          coverUrl: null,
          coverBucket: pending.bucket,
          coverObjectKey: pending.objectKey,
          coverContentType: pending.contentType,
          coverSizeBytes: pending.sizeBytes,
          updatedBy: request.currentUser!.id,
          updatedAt: new Date(),
        })
        .where(eq(feedPosts.id, id))
        .returning();
      if (!updated) throw new Error('Feed post disappeared during cover replacement');
      return { current, updated };
    });
    if (result.current.coverObjectKey && result.current.coverObjectKey !== pending.objectKey) {
      await deleteFeedCoverObject(app.s3, result.current).catch((error) => {
        app.log.error({ error, postId: id }, 'Previous feed cover cleanup failed');
      });
    }
    await writeAudit(request, {
      action: 'feed.cover.upload.complete',
      entityType: 'feed_post',
      entityId: id,
      metadata: { uploadId: body.uploadId, sizeBytes: body.sizeBytes },
    });
    return serializeAdminFeedPost(app, result.updated);
  });

  app.delete('/admin/feed/:id/cover', { preHandler: writeGuards }, async (request, reply) => {
    const { id } = uuidParams.parse(request.params);
    const result = await app.db.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(feedPosts)
        .where(eq(feedPosts.id, id))
        .for('update')
        .limit(1);
      if (!current) throw new AppError('FEED_POST_NOT_FOUND', 'Публикация не найдена', 404);
      await transaction
        .update(feedPosts)
        .set({
          coverUrl: null,
          coverBucket: null,
          coverObjectKey: null,
          coverContentType: null,
          coverSizeBytes: null,
          updatedBy: request.currentUser!.id,
          updatedAt: new Date(),
        })
        .where(eq(feedPosts.id, id));
      return current;
    });
    await deleteFeedCoverObject(app.s3, result).catch((error) => {
      app.log.error({ error, postId: id }, 'Deleted feed cover cleanup failed');
    });
    await writeAudit(request, {
      action: 'feed.cover.delete',
      entityType: 'feed_post',
      entityId: id,
    });
    return reply.code(204).send();
  });
};
