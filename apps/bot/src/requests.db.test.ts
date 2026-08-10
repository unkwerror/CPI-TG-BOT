import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, eventRequests, events, outboxEvents, users } from '@cpi/db';
import {
  findRequestEvent,
  listRequestEvents,
  saveEventRequest,
  saveProfileFields,
} from './requests';

/** Запуск: TEST_DATABASE_URL=postgresql://… npx vitest run */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('collecting requests left in the bot', () => {
  const database = createDatabase(databaseUrl ?? '', { max: 2 });
  const openEventId = '2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01';
  const closedEventId = '2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c02';
  const pastEventId = '2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c03';
  const telegramUserId = 990000000020n;
  const eventIds = [openEventId, closedEventId, pastEventId];
  const hour = 60 * 60 * 1_000;

  const eventRow = (
    id: string,
    suffix: string,
    overrides: { acceptsRequests: boolean; endsAt: Date; startsAt?: Date },
  ) => ({
    id,
    title: `Запросы ${suffix}`,
    slug: `requests-${suffix}`,
    shortCode: `REQ${suffix}`,
    organizer: 'Стартап-студия НГУ',
    startsAt: overrides.startsAt ?? new Date(Date.now() - hour),
    endsAt: overrides.endsAt,
    acceptUploadsFrom: new Date(Date.now() - hour),
    acceptUploadsUntil: new Date(Date.now() + hour),
    status: 'running' as const,
    acceptsRequests: overrides.acceptsRequests,
  });

  const cleanup = async () => {
    const people = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    const personIds = people.map((row) => row.id);
    await database.db.delete(eventRequests).where(inArray(eventRequests.eventId, eventIds));
    if (personIds.length > 0) {
      await database.db.delete(eventRequests).where(inArray(eventRequests.userId, personIds));
      await database.db.delete(outboxEvents).where(inArray(outboxEvents.aggregateId, personIds));
    }
    await database.db.delete(events).where(inArray(events.id, eventIds));
    await database.db.delete(users).where(eq(users.telegramUserId, telegramUserId));
  };

  const seed = async () => {
    await cleanup();
    await database.db.insert(events).values([
      eventRow(openEventId, 'A', { acceptsRequests: true, endsAt: new Date(Date.now() + hour) }),
      eventRow(closedEventId, 'B', { acceptsRequests: false, endsAt: new Date(Date.now() + hour) }),
      eventRow(pastEventId, 'C', {
        acceptsRequests: true,
        startsAt: new Date(Date.now() - 4 * hour),
        endsAt: new Date(Date.now() - hour),
      }),
    ]);
    const [person] = await database.db
      .insert(users)
      .values({ telegramUserId, telegramFirstName: 'Мария', source: 'bot' })
      .returning({ id: users.id });
    return person!.id;
  };

  beforeEach(seed);
  afterAll(async () => {
    await cleanup();
    await database.pool.end();
  });

  it('offers only events that accept requests and have not finished', async () => {
    const available = await listRequestEvents(database.db);
    const offered = available.map((event) => event.id);
    expect(offered).toContain(openEventId);
    expect(offered).not.toContain(closedEventId);
    expect(offered).not.toContain(pastEventId);
  });

  it('refuses an event that no longer accepts requests', async () => {
    expect(await findRequestEvent(database.db, openEventId)).not.toBeNull();
    expect(await findRequestEvent(database.db, closedEventId)).toBeNull();
    expect(await findRequestEvent(database.db, pastEventId)).toBeNull();
  });

  it('stores the request and asks the team about it', async () => {
    const userId = await seed();
    const saved = await saveEventRequest(database.db, {
      eventId: openEventId,
      userId,
      text: 'Нужна помощь с заявкой',
    });

    expect(saved.appended).toBe(false);
    const [stored] = await database.db
      .select()
      .from(eventRequests)
      .where(eq(eventRequests.id, saved.id));
    expect(stored?.status).toBe('new');
    expect(stored?.text).toBe('Нужна помощь с заявкой');

    const [notice] = await database.db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.type, 'event_request.created'), eq(outboxEvents.aggregateId, saved.id)),
      );
    expect(notice?.processedAt).toBeNull();
  });

  // Иначе у команды копятся отдельные карточки об одном и том же деле.
  it('adds a second message to the request that is still open', async () => {
    const userId = await seed();
    const first = await saveEventRequest(database.db, {
      eventId: openEventId,
      userId,
      text: 'Нужна помощь с заявкой',
      attachments: [{ fileId: 'file-1', kind: 'photo' }],
    });
    const second = await saveEventRequest(database.db, {
      eventId: openEventId,
      userId,
      text: 'Забыл добавить: сроки горят',
      attachments: [{ fileId: 'file-2', kind: 'document', fileName: 'заявка.pdf' }],
    });

    expect(second.appended).toBe(true);
    expect(second.id).toBe(first.id);
    const [stored] = await database.db
      .select()
      .from(eventRequests)
      .where(eq(eventRequests.id, first.id));
    expect(stored?.text).toContain('Нужна помощь с заявкой');
    expect(stored?.text).toContain('сроки горят');
    expect(stored?.attachments).toHaveLength(2);
  });

  it('starts a new request once the previous one is closed', async () => {
    const userId = await seed();
    const first = await saveEventRequest(database.db, {
      eventId: openEventId,
      userId,
      text: 'Первый вопрос',
    });
    await database.db
      .update(eventRequests)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(eventRequests.id, first.id));

    const second = await saveEventRequest(database.db, {
      eventId: openEventId,
      userId,
      text: 'Новый вопрос',
    });
    expect(second.appended).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  /** Профиль, заполненный в боте, — единственный путь в CRM для такого человека. */
  it('queues the person for CRM once the profile is filled in the bot', async () => {
    const userId = await seed();
    await saveProfileFields(database.db, userId, {
      fullName: 'Новикова Мария Ивановна',
      phone: '+79130000000',
    });

    const [stored] = await database.db.select().from(users).where(eq(users.id, userId));
    expect(stored?.fullName).toBe('Новикова Мария Ивановна');
    const [queued] = await database.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, 'crm.user.sync'), eq(outboxEvents.aggregateId, userId)));
    expect(queued?.processedAt).toBeNull();
  });
});
