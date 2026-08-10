import type { z } from 'zod';
import type { events } from '@cpi/db';
import type { eventCreateSchema, eventUpdateSchema } from '@cpi/shared';

export const EVENT_TIME_ZONE = 'Asia/Novosibirsk';

export function createEventValues(
  body: z.infer<typeof eventCreateSchema>,
  userId: string,
): typeof events.$inferInsert {
  return {
    title: body.title,
    slug: body.slug,
    shortCode: body.shortCode,
    description: body.description ?? null,
    organizer: body.organizer,
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
    timezone: EVENT_TIME_ZONE,
    venue: body.venue ?? null,
    city: body.city ?? null,
    format: body.format,
    status: body.status,
    tags: body.tags,
    coverUrl: body.coverUrl ?? null,
    acceptUploadsFrom: new Date(body.acceptUploadsFrom),
    acceptUploadsUntil: new Date(body.acceptUploadsUntil),
    maxFileSizeBytes: body.maxFileSizeBytes,
    allowedMimeTypes: body.allowedMimeTypes,
    blockedExtensions: body.blockedExtensions,
    directAccessEnabled: body.directAccessEnabled,
    acceptsRequests: body.acceptsRequests,
    createdBy: userId,
    updatedBy: userId,
  };
}

export function updateEventValues(
  body: z.infer<typeof eventUpdateSchema>,
  userId: string,
): Partial<typeof events.$inferInsert> {
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.slug === undefined ? {} : { slug: body.slug }),
    ...(body.shortCode === undefined ? {} : { shortCode: body.shortCode }),
    ...(body.description === undefined ? {} : { description: body.description ?? null }),
    ...(body.organizer === undefined ? {} : { organizer: body.organizer }),
    ...(body.startsAt === undefined ? {} : { startsAt: new Date(body.startsAt) }),
    ...(body.endsAt === undefined ? {} : { endsAt: new Date(body.endsAt) }),
    timezone: EVENT_TIME_ZONE,
    ...(body.venue === undefined ? {} : { venue: body.venue ?? null }),
    ...(body.city === undefined ? {} : { city: body.city ?? null }),
    ...(body.format === undefined ? {} : { format: body.format }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.coverUrl === undefined ? {} : { coverUrl: body.coverUrl ?? null }),
    ...(body.acceptUploadsFrom === undefined
      ? {}
      : { acceptUploadsFrom: new Date(body.acceptUploadsFrom) }),
    ...(body.acceptUploadsUntil === undefined
      ? {}
      : { acceptUploadsUntil: new Date(body.acceptUploadsUntil) }),
    ...(body.maxFileSizeBytes === undefined ? {} : { maxFileSizeBytes: body.maxFileSizeBytes }),
    ...(body.allowedMimeTypes === undefined ? {} : { allowedMimeTypes: body.allowedMimeTypes }),
    ...(body.blockedExtensions === undefined ? {} : { blockedExtensions: body.blockedExtensions }),
    ...(body.directAccessEnabled === undefined
      ? {}
      : { directAccessEnabled: body.directAccessEnabled }),
    ...(body.acceptsRequests === undefined ? {} : { acceptsRequests: body.acceptsRequests }),
    updatedBy: userId,
  };
}
