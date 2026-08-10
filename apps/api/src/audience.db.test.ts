import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifacts, createDatabase, events, eventParticipants, submissions, users } from '@cpi/db';
import { encodeKeysetCursor } from '@cpi/shared';
import { audienceCounters, countAudience, selectAudience } from './audience';

/**
 * Проверки на настоящей базе: подзапросы аудитории нельзя проверить заглушкой,
 * а именно в них живут ошибки вроде потери связи с внешней таблицей.
 * Запуск: TEST_DATABASE_URL=postgresql://… npx vitest run
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('audience queries', () => {
  const starterTelegramId = 990000000001n;
  const memberTelegramId = 990000000002n;
  const marker = '99000000000';
  const database = createDatabase(databaseUrl ?? '', { max: 2 });
  let starterId = '';
  let memberId = '';

  // Внешние ключи стоят на RESTRICT, поэтому порядок удаления обратный вставке.
  const cleanup = async () => {
    const existing = await database.db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.telegramUserId, [starterTelegramId, memberTelegramId]));
    const ids = existing.map((row) => row.id);
    if (ids.length > 0) {
      await database.db.delete(artifacts).where(inArray(artifacts.userId, ids));
      await database.db.delete(submissions).where(inArray(submissions.userId, ids));
      await database.db.delete(eventParticipants).where(inArray(eventParticipants.userId, ids));
      await database.db.delete(users).where(inArray(users.id, ids));
    }
    await database.db.delete(events).where(inArray(events.slug, ['audience-db-check']));
  };

  beforeAll(async () => {
    await cleanup();
    const [event] = await database.db
      .insert(events)
      .values({
        title: 'Проверка аудитории',
        slug: 'audience-db-check',
        shortCode: 'AUDDB',
        organizer: 'Студия',
        startsAt: new Date('2026-08-01T00:00:00Z'),
        endsAt: new Date('2026-08-02T00:00:00Z'),
        acceptUploadsFrom: new Date('2026-08-01T00:00:00Z'),
        acceptUploadsUntil: new Date('2026-09-01T00:00:00Z'),
        status: 'published',
        format: 'offline',
      })
      .returning({ id: events.id });

    const [starter] = await database.db
      .insert(users)
      .values({
        telegramUserId: starterTelegramId,
        telegramFirstName: 'Иван',
        telegramLastName: 'Стартовый',
        source: 'bot',
        botStartedAt: new Date('2026-08-05T10:00:00Z'),
        createdAt: new Date('2026-08-05T10:00:00Z'),
      })
      .returning({ id: users.id });
    starterId = starter!.id;

    const [member] = await database.db
      .insert(users)
      .values({
        telegramUserId: memberTelegramId,
        fullName: 'Петров Пётр Петрович',
        phone: '+7 999 111-22-33',
        source: 'miniapp',
        botStartedAt: new Date('2026-08-06T10:00:00Z'),
        createdAt: new Date('2026-08-06T10:00:00Z'),
        crmPersonId: '11111111-1111-4111-8111-111111111111',
      })
      .returning({ id: users.id });
    memberId = member!.id;

    await database.db.insert(eventParticipants).values({
      userId: memberId,
      eventId: event!.id,
      joinedAt: new Date('2026-08-06T11:00:00Z'),
    });
    const [submission] = await database.db
      .insert(submissions)
      .values({
        userId: memberId,
        eventId: event!.id,
        idempotencyKey: 'audience-db-check',
        status: 'ready',
      })
      .returning({ id: submissions.id });
    // Два файла одинакового размера: на них ошибался старый `sum(distinct …)`.
    for (const name of ['a.pdf', 'b.pdf']) {
      await database.db.insert(artifacts).values({
        submissionId: submission!.id,
        userId: memberId,
        eventId: event!.id,
        idempotencyKey: `audience-db-${name}`,
        originalName: name,
        displayName: name,
        mimeType: 'application/pdf',
        kind: 'document',
        sizeBytes: 1_000,
        bucket: 'private',
        objectKey: `audience-db/${name}`,
        status: 'ready',
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await database.pool.end();
  });

  it('lists people who only pressed Start next to full participants', async () => {
    const rows = await selectAudience(database.db, { filter: 'all', q: marker, limit: 10 });
    expect(rows.map((row) => row.id).sort()).toEqual([starterId, memberId].sort());
  });

  it('sums two files of equal size instead of collapsing them', async () => {
    const rows = await selectAudience(database.db, { filter: 'all', q: marker, limit: 10 });
    expect(rows.find((row) => row.id === memberId)?.totalBytes).toBe(2_000);
    expect(rows.find((row) => row.id === memberId)?.artifactCount).toBe(2);
    expect(rows.find((row) => row.id === memberId)?.submissionCount).toBe(1);
  });

  it('composes a display name out of the Telegram name', async () => {
    const rows = await selectAudience(database.db, {
      filter: 'unregistered',
      q: marker,
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramName).toBe('Иван Стартовый');
    expect(rows[0]?.fullName).toBeNull();
  });

  it('separates participants, registered people and those missing from CRM', async () => {
    const participants = await selectAudience(database.db, {
      filter: 'participants',
      q: marker,
      limit: 10,
    });
    expect(participants.map((row) => row.id)).toEqual([memberId]);
    const registered = await selectAudience(database.db, {
      filter: 'registered',
      q: marker,
      limit: 10,
    });
    expect(registered.map((row) => row.id)).toEqual([memberId]);
    const pending = await selectAudience(database.db, {
      filter: 'crm_pending',
      q: marker,
      limit: 10,
    });
    expect(pending.map((row) => row.id)).toEqual([starterId]);
  });

  it('finds a person by phone digits, Telegram id and a Russian name', async () => {
    const byPhone = await selectAudience(database.db, {
      filter: 'all',
      q: '9991112233',
      limit: 10,
    });
    expect(byPhone.map((row) => row.id)).toContain(memberId);
    const byTelegram = await selectAudience(database.db, {
      filter: 'all',
      q: '990000000001',
      limit: 10,
    });
    expect(byTelegram.map((row) => row.id)).toEqual([starterId]);
    const byName = await selectAudience(database.db, { filter: 'all', q: 'петров', limit: 10 });
    expect(byName.map((row) => row.id)).toContain(memberId);
  });

  it('walks pages by the composite cursor without repeating a row', async () => {
    const first = await selectAudience(database.db, { filter: 'all', q: marker, limit: 1 });
    expect(first).toHaveLength(1);
    const second = await selectAudience(database.db, {
      filter: 'all',
      q: marker,
      limit: 10,
      cursor: encodeKeysetCursor(first[0]!),
    });
    expect(second.map((row) => row.id)).not.toContain(first[0]!.id);
    expect(second).toHaveLength(1);
  });

  it('counts the selection and the section totals', async () => {
    expect(await countAudience(database.db, { filter: 'all', q: marker, limit: 0 })).toBe(2);
    const counters = await audienceCounters(database.db);
    expect(counters.all).toBeGreaterThanOrEqual(2);
    expect(counters.unregistered).toBeGreaterThanOrEqual(1);
    expect(counters.participants).toBeGreaterThanOrEqual(1);
  });
});
