import { and, eq, isNull } from 'drizzle-orm';
import { type Database, outboxEvents } from '@cpi/db';

type EventBroadcastRecord = {
  id: string;
  status: 'draft' | 'published' | 'running' | 'finished' | 'archived';
  acceptUploadsFrom: Date;
  acceptUploadsUntil: Date;
  deletedAt: Date | null;
};

type FeedBroadcastRecord = {
  id: string;
  kind: 'news' | 'event' | 'product' | 'system';
  status: 'draft' | 'published' | 'archived';
  audience: 'all' | 'participants' | 'admins';
  publishedAt: Date | null;
};

type ProductBroadcastRecord = {
  id: string;
  status: 'draft' | 'published' | 'paused' | 'archived';
  availableFrom: Date | null;
  availableUntil?: Date | null;
  deletedAt: Date | null;
};

export type ManualContentBroadcastTarget =
  | { entityType: 'event'; record: EventBroadcastRecord }
  | { entityType: 'feed_post'; record: FeedBroadcastRecord }
  | { entityType: 'product'; record: ProductBroadcastRecord };

export type ContentBroadcastPlan = {
  type:
    | 'broadcast.event.published'
    | 'broadcast.event.uploads_opened'
    | 'broadcast.feed.published'
    | 'broadcast.product.published';
  aggregateType: 'event' | 'feed_post' | 'store_product';
  aggregateId: string;
  payload: Record<string, string>;
  availableAt: Date;
  createIfMissing: boolean;
};

function activeEventStatus(status: EventBroadcastRecord['status']): boolean {
  return status === 'published' || status === 'running';
}

function notBefore(value: Date | null, now: Date): Date {
  return value && value > now ? value : now;
}

export function planEventBroadcasts(
  event: EventBroadcastRecord,
  previous: Pick<
    EventBroadcastRecord,
    'status' | 'acceptUploadsFrom' | 'acceptUploadsUntil' | 'deletedAt'
  > | null,
  now = new Date(),
): ContentBroadcastPlan[] {
  if (event.deletedAt || !activeEventStatus(event.status)) return [];
  const wasActive = Boolean(previous && !previous.deletedAt && activeEventStatus(previous.status));
  const plans: ContentBroadcastPlan[] = [];
  if (!wasActive) {
    plans.push({
      type: 'broadcast.event.published',
      aggregateType: 'event',
      aggregateId: event.id,
      payload: { eventId: event.id },
      availableAt: now,
      createIfMissing: true,
    });
  }
  if (event.acceptUploadsUntil > now) {
    const opensLater = event.acceptUploadsFrom > now;
    // When publication and acceptance happen together, the publication text
    // already says that uploads are open, so users receive one message.
    if (opensLater || wasActive) {
      plans.push({
        type: 'broadcast.event.uploads_opened',
        aggregateType: 'event',
        aggregateId: event.id,
        payload: { eventId: event.id },
        availableAt: notBefore(event.acceptUploadsFrom, now),
        createIfMissing: !wasActive,
      });
    }
  }
  return plans;
}

export function planFeedBroadcasts(
  post: FeedBroadcastRecord,
  previous: Pick<FeedBroadcastRecord, 'kind' | 'status' | 'audience'> | null,
  now = new Date(),
): ContentBroadcastPlan[] {
  if (post.kind !== 'news' || post.status !== 'published' || post.audience !== 'all') {
    return [];
  }
  const wasPublic = Boolean(
    previous &&
    previous.kind === 'news' &&
    previous.status === 'published' &&
    previous.audience === 'all',
  );
  return [
    {
      type: 'broadcast.feed.published',
      aggregateType: 'feed_post',
      aggregateId: post.id,
      payload: { postId: post.id },
      availableAt: notBefore(post.publishedAt, now),
      createIfMissing: !wasPublic,
    },
  ];
}

export function planProductBroadcasts(
  product: ProductBroadcastRecord,
  previous: Pick<ProductBroadcastRecord, 'status'> | null,
  now = new Date(),
): ContentBroadcastPlan[] {
  if (product.deletedAt || product.status !== 'published') return [];
  return [
    {
      type: 'broadcast.product.published',
      aggregateType: 'store_product',
      aggregateId: product.id,
      payload: { productId: product.id },
      availableAt: notBefore(product.availableFrom, now),
      createIfMissing: previous?.status !== 'published',
    },
  ];
}

export function planManualContentBroadcast(
  target: ManualContentBroadcastTarget,
  broadcastId: string,
  now = new Date(),
): ContentBroadcastPlan | null {
  const campaignId = broadcastId.trim();
  if (!campaignId) throw new Error('Manual broadcast id is required');

  if (target.entityType === 'event') {
    const event = target.record;
    if (event.deletedAt || !activeEventStatus(event.status)) return null;
    return {
      type: 'broadcast.event.published',
      aggregateType: 'event',
      aggregateId: campaignId,
      payload: { eventId: event.id, broadcastId: campaignId },
      availableAt: now,
      createIfMissing: true,
    };
  }

  if (target.entityType === 'feed_post') {
    const post = target.record;
    if (
      post.kind !== 'news' ||
      post.status !== 'published' ||
      post.audience !== 'all' ||
      (post.publishedAt !== null && post.publishedAt > now)
    ) {
      return null;
    }
    return {
      type: 'broadcast.feed.published',
      aggregateType: 'feed_post',
      aggregateId: campaignId,
      payload: { postId: post.id, broadcastId: campaignId },
      availableAt: now,
      createIfMissing: true,
    };
  }

  const product = target.record;
  if (
    product.deletedAt ||
    product.status !== 'published' ||
    (product.availableFrom !== null && product.availableFrom > now) ||
    (product.availableUntil !== null &&
      product.availableUntil !== undefined &&
      product.availableUntil < now)
  ) {
    return null;
  }
  return {
    type: 'broadcast.product.published',
    aggregateType: 'store_product',
    aggregateId: campaignId,
    payload: { productId: product.id, broadcastId: campaignId },
    availableAt: now,
    createIfMissing: true,
  };
}

async function persistPlan(database: Database, plan: ContentBroadcastPlan): Promise<void> {
  if (plan.createIfMissing) {
    await database
      .insert(outboxEvents)
      .values({
        type: plan.type,
        aggregateType: plan.aggregateType,
        aggregateId: plan.aggregateId,
        payload: plan.payload,
        availableAt: plan.availableAt,
      })
      .onConflictDoNothing();
  }
  // A future publication/acceptance time can be edited. Reschedule only an
  // event that has not been dispatched; a delivered broadcast is immutable.
  await database
    .update(outboxEvents)
    .set({
      payload: plan.payload,
      availableAt: plan.availableAt,
      attempts: 0,
      lastError: null,
    })
    .where(
      and(
        eq(outboxEvents.type, plan.type),
        eq(outboxEvents.aggregateType, plan.aggregateType),
        eq(outboxEvents.aggregateId, plan.aggregateId),
        isNull(outboxEvents.processedAt),
      ),
    );
}

async function persistPlans(database: Database, plans: ContentBroadcastPlan[]): Promise<void> {
  for (const plan of plans) await persistPlan(database, plan);
}

export function enqueueEventBroadcasts(
  database: Database,
  event: EventBroadcastRecord,
  previous: Pick<
    EventBroadcastRecord,
    'status' | 'acceptUploadsFrom' | 'acceptUploadsUntil' | 'deletedAt'
  > | null,
): Promise<void> {
  return persistPlans(database, planEventBroadcasts(event, previous));
}

export function enqueueFeedBroadcasts(
  database: Database,
  post: FeedBroadcastRecord,
  previous: Pick<FeedBroadcastRecord, 'kind' | 'status' | 'audience'> | null,
): Promise<void> {
  return persistPlans(database, planFeedBroadcasts(post, previous));
}

export function enqueueProductBroadcasts(
  database: Database,
  product: ProductBroadcastRecord,
  previous: Pick<ProductBroadcastRecord, 'status'> | null,
): Promise<void> {
  return persistPlans(database, planProductBroadcasts(product, previous));
}

export async function enqueueManualContentBroadcast(
  database: Database,
  target: ManualContentBroadcastTarget,
  broadcastId: string,
): Promise<ContentBroadcastPlan | null> {
  const plan = planManualContentBroadcast(target, broadcastId);
  if (!plan) return null;
  await persistPlan(database, plan);
  return plan;
}
