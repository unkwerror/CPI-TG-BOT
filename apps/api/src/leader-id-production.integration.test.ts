import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDatabase,
  events,
  leaderIdBindings,
  leaderIdEventRegistrations,
  users,
} from '@cpi/db';
import type { StoredLeaderIdRegistrationResult } from './leader-id-contract';
import { leaderIdPostOutcomeUnknown } from './leader-id-contract';
import {
  DrizzleLeaderIdBindingRepository,
  DrizzleLeaderIdRegistrationRepository,
  type RedisLeaderIdUserLease,
} from './leader-id-production';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl))('production Leader-ID durable registration claim', () => {
  const connection = createDatabase(databaseUrl!, { max: 4 });
  let catalystUserId = '';
  let catalystEventId = '';
  const repository = new DrizzleLeaderIdRegistrationRepository(
    connection.db,
    {} as RedisLeaderIdUserLease,
  );
  const bindingRepository = new DrizzleLeaderIdBindingRepository(connection.db);

  beforeAll(async () => {
    const [seededUser] = await connection.db.select({ id: users.id }).from(users).limit(1);
    if (!seededUser) throw new Error('Fresh migrated database has no bootstrap user');
    catalystUserId = seededUser.id;
    const [configuredEvent] = await connection.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.leaderIdEventId, 606466))
      .limit(1);
    if (!configuredEvent) throw new Error('Leader-ID seed event is missing');
    catalystEventId = configuredEvent.id;
    await connection.db
      .delete(leaderIdEventRegistrations)
      .where(eq(leaderIdEventRegistrations.userId, catalystUserId));
    await connection.db
      .insert(leaderIdBindings)
      .values({
        userId: catalystUserId,
        leaderIdUserId: 77,
        encryptedTokens: 'integration-test-envelope',
        linkedAt: new Date('2026-08-28T05:00:00.000Z'),
      })
      .onConflictDoUpdate({
        target: leaderIdBindings.userId,
        set: {
          leaderIdUserId: 77,
          encryptedTokens: 'integration-test-envelope',
          linkedAt: new Date('2026-08-28T05:00:00.000Z'),
        },
      });
  });

  afterAll(async () => {
    if (catalystUserId) {
      await connection.db
        .delete(leaderIdEventRegistrations)
        .where(eq(leaderIdEventRegistrations.userId, catalystUserId));
      await connection.db
        .delete(leaderIdBindings)
        .where(eq(leaderIdBindings.userId, catalystUserId));
    }
    await connection.pool.end();
  });

  it('permits one pre-POST winner and fences stale finalizers by UUID token', async () => {
    const base = {
      catalystUserId,
      leaderIdUserId: 77,
      catalystEventId,
      leaderIdEventId: 606466,
      status: 'FAILED' as const,
      retryable: true,
      errorCode: leaderIdPostOutcomeUnknown,
      attemptCount: 1,
      updatedAt: '2026-08-28T05:00:00.000Z',
    };
    const claims: StoredLeaderIdRegistrationResult[] = [
      { ...base, claimToken: '6141d3a7-bf9d-4636-b487-52a108a113b0' },
      { ...base, claimToken: '2b8a4667-23d6-46da-b8a2-ac718881bde1' },
    ];

    const outcomes = await Promise.all(claims.map((claim) => repository.claimAttempt(claim, 0)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = claims[outcomes.findIndex(Boolean)]!;
    const loser = claims[outcomes.findIndex((outcome) => !outcome)]!;
    const loserWithoutError = { ...loser };
    const winnerWithoutError = { ...winner };
    const loserOrdinaryResult = { ...loser };
    delete loserWithoutError.errorCode;
    delete winnerWithoutError.errorCode;
    delete loserOrdinaryResult.errorCode;
    delete loserOrdinaryResult.claimToken;

    const staleOrdinarySave = await repository.saveResult(
      {
        ...loserOrdinaryResult,
        status: 'REGISTRATION_CLOSED',
        retryable: false,
        errorCode: 'REGISTRATION_CLOSED',
      },
      null,
    );
    expect(staleOrdinarySave).toMatchObject({
      status: 'FAILED',
      claimToken: winner.claimToken,
      errorCode: leaderIdPostOutcomeUnknown,
    });

    const staleCompletion = await repository.completeClaim({
      ...loserWithoutError,
      status: 'REGISTERED',
      retryable: false,
    });
    expect(staleCompletion).toMatchObject({
      status: 'FAILED',
      claimToken: winner.claimToken,
      errorCode: leaderIdPostOutcomeUnknown,
    });

    const completed = await repository.completeClaim({
      ...winnerWithoutError,
      status: 'REGISTERED',
      retryable: false,
      officialParticipationId: 'official-participation',
      officialModeration: 'approved',
    });
    expect(completed).toMatchObject({
      status: 'REGISTERED',
      officialParticipationId: 'official-participation',
    });
    expect(completed).not.toHaveProperty('claimToken');

    await expect(
      repository.completeClaim({
        ...loser,
        status: 'FAILED',
        retryable: false,
        errorCode: 'STALE_WORKER',
      }),
    ).resolves.toMatchObject({ status: 'REGISTERED' });
  });

  it('serializes relinking against the durable pre-POST claim', async () => {
    await connection.db
      .delete(leaderIdEventRegistrations)
      .where(eq(leaderIdEventRegistrations.userId, catalystUserId));
    await connection.db
      .update(leaderIdBindings)
      .set({
        leaderIdUserId: 77,
        encryptedTokens: 'old-envelope',
        linkedAt: new Date('2026-08-28T05:00:00.000Z'),
      })
      .where(eq(leaderIdBindings.userId, catalystUserId));
    const claim: StoredLeaderIdRegistrationResult = {
      catalystUserId,
      leaderIdUserId: 77,
      catalystEventId,
      leaderIdEventId: 606466,
      status: 'FAILED',
      retryable: true,
      errorCode: leaderIdPostOutcomeUnknown,
      attemptCount: 1,
      claimToken: '8199e190-16e0-4f8e-8478-c99f69304dd8',
      updatedAt: '2026-08-28T05:01:00.000Z',
    };

    const [claimWon, relinkApplied] = await Promise.all([
      repository.claimAttempt(claim, 0),
      bindingRepository.upsertVerifiedBinding({
        catalystUserId,
        leaderIdUserId: 88,
        encryptedTokens: 'new-envelope',
        linkedAt: '2026-08-28T05:02:00.000Z',
      }),
    ]);

    expect([claimWon, relinkApplied].filter(Boolean)).toHaveLength(1);
    await expect(bindingRepository.findByCatalystUserId(catalystUserId)).resolves.toMatchObject({
      leaderIdUserId: claimWon ? 77 : 88,
    });
  });
});
