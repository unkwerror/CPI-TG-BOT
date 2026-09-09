import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, leaderIdBindings, userMessengerIdentities, users } from '@cpi/db';
import { buildUserSheets } from './user-export';
import type { WorkerContext } from './context';

const databaseUrl = process.env.QUICK_ANSWER_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('user export with PostgreSQL', () => {
  const { db, pool } = createDatabase(databaseUrl ?? 'postgresql://unused');
  afterAll(async () => {
    await pool.end();
  });
  it('exports beyond the UI limit, deduplicates linked messengers and uses verified Leader ID', async () => {
    const batch = Array.from({ length: 505 }, () => ({
      id: randomUUID(),
      fullName: 'Пользователь выгрузки',
    }));
    await db.insert(users).values(batch);
    const id = batch[0]!.id;
    await db.insert(userMessengerIdentities).values([
      {
        userId: id,
        provider: 'telegram',
        externalUserId: String(Date.now()),
        chatId: '123',
        firstBotStartedAt: new Date(),
        firstAppOpenedAt: new Date(),
      },
      {
        userId: id,
        provider: 'max',
        externalUserId: String(Date.now()),
        firstAppOpenedAt: new Date(),
      },
    ]);
    await db.insert(leaderIdBindings).values({
      userId: id,
      leaderIdUserId: Date.now(),
      encryptedTokens: 'test-token-not-exported',
    });
    const sheets = await buildUserSheets({ db, config: {} } as WorkerContext, async () => {});
    const rows = sheets[0]!.rows as Array<{
      id: string;
      botUsed: string;
      appOpened: string;
      leaderLinked: string;
      inChat: string;
    }>;
    const batchIds = new Set<string>(batch.map((row) => row.id));
    expect(rows.filter((row) => batchIds.has(row.id))).toHaveLength(505);
    expect(rows.filter((row) => row.id === id)).toHaveLength(1);
    expect(rows.find((row) => row.id === id)).toMatchObject({
      botUsed: 'Да',
      appOpened: 'Да',
      leaderLinked: 'Да',
      inChat: 'Неизвестно',
    });
    expect(JSON.stringify(sheets)).not.toContain('test-token-not-exported');
  });
});
