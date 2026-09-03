import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { events, feedPosts, outboxEvents, storeProducts } from '@cpi/db';
import type { WorkerContext } from './context';

export async function reconcileContentBroadcastSchedules(
  context: WorkerContext,
): Promise<{ eventUploads: number; feedPosts: number; products: number }> {
  const now = new Date();
  const [futureEventUploads, futurePosts, futureProducts] = await Promise.all([
    context.db
      .select({ id: events.id, availableAt: events.acceptUploadsFrom })
      .from(events)
      .where(
        and(
          inArray(events.status, ['published', 'running']),
          isNull(events.deletedAt),
          gt(events.acceptUploadsFrom, now),
          gt(events.acceptUploadsUntil, now),
        ),
      )
      .limit(500),
    context.db
      .select({ id: feedPosts.id, availableAt: feedPosts.publishedAt })
      .from(feedPosts)
      .where(
        and(
          eq(feedPosts.kind, 'news'),
          eq(feedPosts.status, 'published'),
          eq(feedPosts.audience, 'all'),
          gt(feedPosts.publishedAt, now),
        ),
      )
      .limit(500),
    context.db
      .select({
        id: storeProducts.id,
        availableAt: storeProducts.availableFrom,
      })
      .from(storeProducts)
      .where(
        and(
          eq(storeProducts.status, 'published'),
          isNull(storeProducts.deletedAt),
          gt(storeProducts.availableFrom, now),
          or(isNull(storeProducts.availableUntil), gt(storeProducts.availableUntil, now)),
        ),
      )
      .limit(500),
  ]);

  const plans: Array<typeof outboxEvents.$inferInsert> = [
    ...futureEventUploads.map((event) => ({
      type: 'broadcast.event.uploads_opened',
      aggregateType: 'event',
      aggregateId: event.id,
      payload: { eventId: event.id },
      availableAt: event.availableAt,
    })),
    ...futurePosts.flatMap((post) =>
      post.availableAt
        ? [
            {
              type: 'broadcast.feed.published',
              aggregateType: 'feed_post',
              aggregateId: post.id,
              payload: { postId: post.id },
              availableAt: post.availableAt,
            },
          ]
        : [],
    ),
    ...futureProducts.flatMap((product) =>
      product.availableAt
        ? [
            {
              type: 'broadcast.product.published',
              aggregateType: 'store_product',
              aggregateId: product.id,
              payload: { productId: product.id },
              availableAt: product.availableAt,
            },
          ]
        : [],
    ),
  ];
  if (plans.length === 0) return { eventUploads: 0, feedPosts: 0, products: 0 };
  const inserted = await context.db
    .insert(outboxEvents)
    .values(plans)
    .onConflictDoNothing()
    .returning({ type: outboxEvents.type });
  return {
    eventUploads: inserted.filter((item) => item.type === 'broadcast.event.uploads_opened').length,
    feedPosts: inserted.filter((item) => item.type === 'broadcast.feed.published').length,
    products: inserted.filter((item) => item.type === 'broadcast.product.published').length,
  };
}
