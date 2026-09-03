import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  eventParticipants,
  eventRewardPolicies,
  events,
  exportJobs,
  outboxEvents,
  type Database,
} from '@cpi/db';
import { eventRoutes } from './events';

const EVENT_ID = '00000000-0000-4000-8000-000000000601';
const USER_ID = '00000000-0000-4000-8000-000000000602';

const eventFixture = {
  id: EVENT_ID,
  title: 'Явное участие Catalyst',
  slug: 'explicit-catalyst-participation',
  shortCode: 'JOIN-601',
  description: 'Регрессионное мероприятие',
  descriptionFormat: 'text',
  cardHtml: null,
  cardPackageId: null,
  organizer: 'Стартап-студия НГУ',
  startsAt: new Date('2026-09-10T03:00:00.000Z'),
  endsAt: new Date('2026-09-10T10:00:00.000Z'),
  timezone: 'Asia/Novosibirsk',
  venue: 'НГУ',
  city: 'Новосибирск',
  format: 'hybrid',
  status: 'published',
  tags: ['Catalyst'],
  searchText: 'явное участие catalyst',
  coverUrl: null,
  acceptUploadsFrom: new Date('2026-08-01T00:00:00.000Z'),
  acceptUploadsUntil: new Date('2026-12-01T00:00:00.000Z'),
  maxFileSizeBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg'],
  blockedExtensions: ['exe'],
  directAccessEnabled: true,
  acceptsRequests: false,
  managedByCrm: false,
  leaderIdEventId: null,
  leaderIdRegistrationActive: false,
  leaderIdRequiredForSubscription: true,
  leaderIdRegistrationOpen: true,
  leaderIdSortOrder: 0,
  leaderIdRequiresQuestionnaire: false,
  activeFormVersionId: null,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  deletedAt: null,
} satisfies typeof events.$inferSelect;

interface ParticipationDatabaseState {
  participantInsertAttempts: number;
  participantRows: Set<string>;
  participantSource: string | null;
  outboxWriteAttempts: number;
  outboxRows: Set<string>;
}

interface SelectBuilder {
  from(table: unknown): SelectBuilder;
  where(...conditions: unknown[]): SelectBuilder;
  orderBy(...conditions: unknown[]): SelectBuilder;
  limit(value: number): Promise<unknown[]>;
  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

interface InsertBuilder {
  values(value: unknown): InsertBuilder;
  onConflictDoNothing(): InsertBuilder;
  onConflictDoUpdate(value: unknown): Promise<unknown[]>;
  returning(value: unknown): Promise<unknown[]>;
}

function participationDatabase() {
  const state: ParticipationDatabaseState = {
    participantInsertAttempts: 0,
    participantRows: new Set(),
    participantSource: null,
    outboxWriteAttempts: 0,
    outboxRows: new Set(),
  };

  const rowsFor = (table: unknown): unknown[] => {
    if (table === events) return [eventFixture];
    if (table === eventParticipants) {
      return state.participantRows.has(`${EVENT_ID}:${USER_ID}`) ? [{ eventId: EVENT_ID }] : [];
    }
    if (table === eventRewardPolicies || table === exportJobs) return [];
    throw new Error('Unexpected table in participation SELECT');
  };

  const select = () => {
    let table: unknown;
    const builder: SelectBuilder = {
      from(nextTable) {
        table = nextTable;
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      async limit() {
        return rowsFor(table);
      },
      then(onfulfilled, onrejected) {
        return Promise.resolve(rowsFor(table)).then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  const insert = (table: unknown) => {
    let payload: unknown;
    const builder: InsertBuilder = {
      values(value) {
        payload = value;
        return builder;
      },
      onConflictDoNothing() {
        return builder;
      },
      async onConflictDoUpdate() {
        if (table !== outboxEvents) throw new Error('Unexpected participation upsert');
        const value = payload as { type: string; aggregateType: string; aggregateId: string };
        state.outboxWriteAttempts += 1;
        state.outboxRows.add(`${value.type}:${value.aggregateType}:${value.aggregateId}`);
        return [];
      },
      async returning() {
        if (table !== eventParticipants) throw new Error('Unexpected participation insert');
        state.participantInsertAttempts += 1;
        const key = `${EVENT_ID}:${USER_ID}`;
        if (state.participantRows.has(key)) return [];
        state.participantRows.add(key);
        state.participantSource = (payload as { source: string }).source;
        return [{ eventId: EVENT_ID }];
      },
    };
    return builder;
  };

  const transactionDatabase = { insert };
  const database = {
    select: vi.fn(select),
    transaction: vi.fn(
      async <Result>(callback: (transaction: typeof transactionDatabase) => Promise<Result>) =>
        callback(transactionDatabase),
    ),
  } as unknown as Database;

  return { database, state };
}

async function participationApp(database: Database) {
  const app = Fastify({ logger: false });
  app.decorate('db', database);
  app.decorateRequest('currentUser', undefined);
  app.decorate('requireAuth', async (request) => {
    request.currentUser = {
      id: USER_ID,
      telegramUserId: 123456789n,
      telegramUsername: 'participant',
      fullName: 'Тестовый Участник',
      organization: null,
      position: null,
      phone: null,
      consentAt: new Date(),
      status: 'active',
      roles: ['participant'],
    };
  });
  app.decorate('requireCsrf', async () => undefined);
  await app.register(eventRoutes);
  await app.ready();
  return app;
}

describe('explicit event participation', () => {
  it('keeps GET read-only and makes repeated participation idempotent', async () => {
    const { database, state } = participationDatabase();
    const app = await participationApp(database);
    try {
      const before = await app.inject({ method: 'GET', url: `/events/${EVENT_ID}` });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({ id: EVENT_ID, isParticipant: false });
      expect(state.participantRows.size).toBe(0);
      expect(state.participantInsertAttempts).toBe(0);
      expect(state.outboxWriteAttempts).toBe(0);
      expect(state.outboxRows.size).toBe(0);

      const first = await app.inject({ method: 'POST', url: `/events/${EVENT_ID}/participate` });
      expect(state.outboxWriteAttempts).toBe(1);
      expect(state.outboxRows.size).toBe(1);

      const replay = await app.inject({ method: 'POST', url: `/events/${EVENT_ID}/participate` });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ joined: true, isParticipant: true });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ joined: false, isParticipant: true });
      expect(state.participantInsertAttempts).toBe(2);
      expect(state.participantRows).toEqual(new Set([`${EVENT_ID}:${USER_ID}`]));
      expect(state.participantSource).toBe('joined_button');
      expect(state.outboxWriteAttempts).toBe(1);
      expect(state.outboxRows.size).toBe(1);

      const after = await app.inject({ method: 'GET', url: `/events/${EVENT_ID}` });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({ id: EVENT_ID, isParticipant: true });
      expect(state.participantRows.size).toBe(1);
      expect(state.outboxWriteAttempts).toBe(1);
      expect(state.outboxRows.size).toBe(1);
    } finally {
      await app.close();
    }
  });
});
