import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { dispatchOutbox, outboxJobId } from './outbox';
import type { WorkerContext } from './context';

interface Row {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
  availableAt: Date;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'crm.user.sync',
    aggregateType: 'user',
    aggregateId: '22222222-2222-4222-8222-222222222222',
    payload: { userId: '22222222-2222-4222-8222-222222222222' },
    attempts: 0,
    availableAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

/** Диспетчер читает строки одним select и обновляет их по одной. */
function contextFor(rows: Row[]) {
  const updates: Array<Record<string, unknown>> = [];
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      return { where: async () => undefined };
    },
  });
  const context = {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => rows }) }),
        }),
      }),
      update,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as WorkerContext;
  return { context, updates };
}

function queues() {
  const crm = { add: vi.fn(async () => undefined) };
  return {
    queues: {
      artifacts: { add: vi.fn(async () => undefined) } as unknown as Queue,
      exports: { add: vi.fn(async () => undefined) } as unknown as Queue,
      notifications: { add: vi.fn(async () => undefined) } as unknown as Queue,
      crm: crm as unknown as Queue,
    },
    crm,
  };
}

describe('outboxJobId', () => {
  it('changes when an event is reopened for another delivery', () => {
    const first = row();
    const reopened = row({ availableAt: new Date('2026-08-10T11:00:00.000Z') });
    expect(outboxJobId(first)).not.toBe(outboxJobId(reopened));
  });

  it('stays equal for two dispatchers that picked the same row', () => {
    expect(outboxJobId(row())).toBe(outboxJobId(row()));
  });

  // BullMQ отклоняет такой ключ: двоеточием он разделяет собственные ключи Redis.
  it('avoids the colon BullMQ rejects in custom ids', () => {
    expect(outboxJobId(row())).not.toContain(':');
  });
});

describe('dispatchOutbox', () => {
  it('queues a repeated CRM sync under a new job id', async () => {
    const reopened = row({ availableAt: new Date('2026-08-10T11:00:00.000Z') });
    const { context } = contextFor([reopened]);
    const { queues: allQueues, crm } = queues();

    const processed = await dispatchOutbox(context, allQueues);

    expect(processed).toBe(1);
    expect(crm.add).toHaveBeenCalledWith(
      'sync-user-to-crm',
      { userId: reopened.aggregateId },
      expect.objectContaining({ jobId: `${reopened.id}-${reopened.availableAt.getTime()}` }),
    );
  });

  it('keeps an unknown event unprocessed instead of losing it', async () => {
    const unknown = row({ type: 'crm.unknown.thing' });
    const { context, updates } = contextFor([unknown]);
    const { queues: allQueues, crm } = queues();

    const processed = await dispatchOutbox(context, allQueues);

    expect(processed).toBe(0);
    expect(crm.add).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ attempts: 1 });
    expect(updates.at(-1)?.lastError).toContain('crm.unknown.thing');
  });
});
