import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, outboxEvents, users } from '@cpi/db';
import { ensureBotUser, markBotBlocked, recordCampaignReply } from './audience';

/** Запуск: TEST_DATABASE_URL=postgresql://… npx vitest run */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('recording people who write to the bot', () => {
  const telegramUserId = 990000000010n;
  const recipientId = '3f4a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
  const database = createDatabase(databaseUrl ?? '', { max: 2 });
  const sender = {
    id: Number(telegramUserId),
    username: 'newcomer',
    first_name: 'Мария',
    last_name: 'Новикова',
    language_code: 'ru',
  };

  const cleanup = async () => {
    const existing = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    if (existing.length > 0) {
      await database.db.delete(outboxEvents).where(
        inArray(
          outboxEvents.aggregateId,
          existing.map((row) => row.id),
        ),
      );
    }
    await database.db.delete(users).where(eq(users.telegramUserId, telegramUserId));
    await database.db
      .delete(outboxEvents)
      .where(eq(outboxEvents.aggregateType, 'campaign_recipient'));
  };

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await database.pool.end();
  });

  it('creates a record on the first contact and queues it for CRM', async () => {
    const userId = await ensureBotUser(database.db, sender);
    expect(userId).toBeTruthy();

    const [created] = await database.db.select().from(users).where(eq(users.id, userId!));
    expect(created?.source).toBe('bot');
    expect(created?.botStartedAt).toBeInstanceOf(Date);
    expect(created?.telegramUsername).toBe('newcomer');
    // Профиль не выдумывается: ФИО появится, только когда человек его укажет.
    expect(created?.fullName).toBeNull();

    const queued = await database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, userId!));
    expect(queued.map((row) => row.type)).toEqual(['crm.user.sync']);
  });

  it('reuses the record, keeps the earliest date and clears the blocked mark', async () => {
    const userId = await ensureBotUser(database.db, sender);
    const [before] = await database.db.select().from(users).where(eq(users.id, userId!));
    await markBotBlocked(database.db, userId!);

    const repeated = await ensureBotUser(database.db, { ...sender, username: 'renamed' });
    expect(repeated).toBe(userId);

    const [after] = await database.db.select().from(users).where(eq(users.id, userId!));
    expect(after?.botStartedAt?.getTime()).toBe(before?.botStartedAt?.getTime());
    expect(after?.telegramUsername).toBe('renamed');
    expect(after?.botBlockedAt).toBeNull();
    const all = await database.db
      .select()
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    expect(all).toHaveLength(1);
  });

  it('keeps one row per distinct campaign reply', async () => {
    await recordCampaignReply(database.db, { recipientId, action: 'INTERESTED' });
    await recordCampaignReply(database.db, { recipientId, action: 'INTERESTED' });
    await recordCampaignReply(database.db, { recipientId, action: 'UNSUBSCRIBED' });
    const replies = await database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'crm.campaign.reply'));
    expect(replies).toHaveLength(2);
  });
});
