import { describe, expect, it } from 'vitest';
import {
  planEventBroadcasts,
  planFeedBroadcasts,
  planManualContentBroadcast,
  planProductBroadcasts,
} from './content-broadcasts';

const now = new Date('2026-08-25T05:00:00.000Z');

describe('content broadcast scheduling', () => {
  it('publishes an event once and schedules a later upload-opening message', () => {
    const plans = planEventBroadcasts(
      {
        id: 'event-id',
        status: 'published',
        acceptUploadsFrom: new Date('2026-08-26T05:00:00.000Z'),
        acceptUploadsUntil: new Date('2026-08-30T05:00:00.000Z'),
        deletedAt: null,
      },
      {
        status: 'draft',
        acceptUploadsFrom: now,
        acceptUploadsUntil: now,
        deletedAt: null,
      },
      now,
    );
    expect(plans.map((plan) => plan.type)).toEqual([
      'broadcast.event.published',
      'broadcast.event.uploads_opened',
    ]);
    expect(plans[1]?.availableAt.toISOString()).toBe('2026-08-26T05:00:00.000Z');
  });

  it('does not duplicate the upload-opening message when publication already has uploads open', () => {
    const plans = planEventBroadcasts(
      {
        id: 'event-id',
        status: 'running',
        acceptUploadsFrom: new Date('2026-08-24T05:00:00.000Z'),
        acceptUploadsUntil: new Date('2026-08-30T05:00:00.000Z'),
        deletedAt: null,
      },
      null,
      now,
    );
    expect(plans.map((plan) => plan.type)).toEqual(['broadcast.event.published']);
  });

  it('broadcasts only public news', () => {
    expect(
      planFeedBroadcasts(
        {
          id: 'post-id',
          kind: 'news',
          status: 'published',
          audience: 'all',
          publishedAt: now,
        },
        { kind: 'news', status: 'draft', audience: 'all' },
        now,
      ),
    ).toHaveLength(1);
    expect(
      planFeedBroadcasts(
        {
          id: 'post-id',
          kind: 'news',
          status: 'published',
          audience: 'admins',
          publishedAt: now,
        },
        null,
        now,
      ),
    ).toEqual([]);
  });

  it('schedules a product for its availability date', () => {
    const [plan] = planProductBroadcasts(
      {
        id: 'product-id',
        status: 'published',
        availableFrom: new Date('2026-09-01T05:00:00.000Z'),
        deletedAt: null,
      },
      { status: 'draft' },
      now,
    );
    expect(plan?.type).toBe('broadcast.product.published');
    expect(plan?.availableAt.toISOString()).toBe('2026-09-01T05:00:00.000Z');
  });

  it('creates a separate idempotent campaign for an already published event', () => {
    const plan = planManualContentBroadcast(
      {
        entityType: 'event',
        record: {
          id: 'event-id',
          status: 'published',
          acceptUploadsFrom: now,
          acceptUploadsUntil: new Date('2026-08-30T05:00:00.000Z'),
          deletedAt: null,
        },
      },
      'manual-campaign-id',
      now,
    );
    expect(plan).toMatchObject({
      type: 'broadcast.event.published',
      aggregateId: 'manual-campaign-id',
      payload: {
        eventId: 'event-id',
        broadcastId: 'manual-campaign-id',
      },
    });
  });

  it('does not manually broadcast scheduled news or an expired product', () => {
    expect(
      planManualContentBroadcast(
        {
          entityType: 'feed_post',
          record: {
            id: 'post-id',
            kind: 'news',
            status: 'published',
            audience: 'all',
            publishedAt: new Date('2026-08-26T05:00:00.000Z'),
          },
        },
        'news-campaign',
        now,
      ),
    ).toBeNull();
    expect(
      planManualContentBroadcast(
        {
          entityType: 'product',
          record: {
            id: 'product-id',
            status: 'published',
            availableFrom: null,
            availableUntil: new Date('2026-08-24T05:00:00.000Z'),
            deletedAt: null,
          },
        },
        'product-campaign',
        now,
      ),
    ).toBeNull();
  });
});
