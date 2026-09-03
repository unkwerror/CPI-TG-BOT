import { describe, expect, it, vi } from 'vitest';
import type { LeaderIdOAuthStateRecord } from './leader-id-contract';
import {
  reconcileLeaderIdSubscriptions,
  RedisLeaderIdOAuthStateRepository,
  RedisLeaderIdUserLease,
  type LeaderIdRedisCommands,
} from './leader-id-production';

const CATALYST_USER_ID = '6d18c346-b053-4ca0-8379-a25b596fb5e6';

class MemoryRedis implements LeaderIdRedisCommands {
  readonly values = new Map<string, string>();
  readonly sets: Array<{
    key: string;
    mode: 'EX' | 'PX';
    duration: number;
    condition: 'NX';
  }> = [];
  renewals = 0;
  releases = 0;

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async set(
    key: string,
    value: string,
    mode: 'EX' | 'PX',
    duration: number,
    condition: 'NX',
  ): Promise<'OK' | null> {
    this.sets.push({ key, mode, duration, condition });
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async eval(
    script: string,
    _numberOfKeys: number,
    key: string,
    ...arguments_: Array<string | number>
  ): Promise<unknown> {
    const ownershipToken = String(arguments_[0]);
    if (script.includes('PEXPIRE')) {
      this.renewals += 1;
      return this.values.get(key) === ownershipToken ? 1 : 0;
    }
    if (script.includes('DEL')) {
      this.releases += 1;
      if (this.values.get(key) !== ownershipToken) return 0;
      this.values.delete(key);
      return 1;
    }
    throw new Error('Unexpected Redis script');
  }
}

describe('production Leader-ID OAuth state persistence', () => {
  it('uses Redis NX+TTL and atomically consumes a digest exactly once', async () => {
    const redis = new MemoryRedis();
    const repository = new RedisLeaderIdOAuthStateRepository(redis, 'cpi-test');
    const digest = Buffer.alloc(32, 5).toString('base64url');
    const record: LeaderIdOAuthStateRecord = {
      catalystUserId: CATALYST_USER_ID,
      expectedLeaderIdUserId: 77,
      createdAt: '2026-08-28T05:00:00.000Z',
      expiresAt: '2026-08-28T05:10:00.000Z',
    };

    await repository.put(digest, record, 600);

    expect(redis.sets).toEqual([
      {
        key: `cpi-test:leader-id:oauth-state:${digest}`,
        mode: 'EX',
        duration: 600,
        condition: 'NX',
      },
    ]);
    expect([...redis.values.keys()]).not.toContain(expect.stringContaining('catalyst'));
    await expect(repository.take(digest)).resolves.toEqual(record);
    await expect(repository.take(digest)).resolves.toBeNull();
  });

  it('refuses to overwrite an existing state digest', async () => {
    const redis = new MemoryRedis();
    const repository = new RedisLeaderIdOAuthStateRepository(redis, 'cpi-test');
    const digest = Buffer.alloc(32, 6).toString('base64url');
    const record: LeaderIdOAuthStateRecord = {
      catalystUserId: CATALYST_USER_ID,
      expectedLeaderIdUserId: 77,
      createdAt: '2026-08-28T05:00:00.000Z',
      expiresAt: '2026-08-28T05:10:00.000Z',
    };

    await repository.put(digest, record, 600);
    await expect(repository.put(digest, record, 600)).rejects.toThrow(/collision/u);
  });
});

describe('production Leader-ID per-user lease', () => {
  it('renews ownership during work and releases only its token', async () => {
    const redis = new MemoryRedis();
    const lease = new RedisLeaderIdUserLease({
      redis,
      redisPrefix: 'cpi-test',
      leaseDurationMs: 1_000,
      renewEveryMs: 100,
      acquisitionWaitMs: 0,
    });

    await expect(
      lease.withLease(CATALYST_USER_ID, async () => {
        await new Promise((resolve) => setTimeout(resolve, 230));
        return 'completed';
      }),
    ).resolves.toBe('completed');

    expect(redis.renewals).toBeGreaterThanOrEqual(2);
    expect(redis.releases).toBe(1);
    expect(redis.values).toHaveLength(0);
  });

  it('returns a retryable busy error instead of entering another active lease', async () => {
    const redis = new MemoryRedis();
    redis.values.set(`cpi-test:leader-id:subscription-lock:${CATALYST_USER_ID}`, 'another-owner');
    const lease = new RedisLeaderIdUserLease({
      redis,
      redisPrefix: 'cpi-test',
      leaseDurationMs: 1_000,
      renewEveryMs: 100,
      acquisitionWaitMs: 0,
    });

    await expect(lease.withLease(CATALYST_USER_ID, async () => undefined)).rejects.toMatchObject({
      code: 'LEADER_ID_SUBSCRIPTION_BUSY',
      statusCode: 409,
    });
  });

  it('detects ownership loss and never deletes the replacement lease', async () => {
    const redis = new MemoryRedis();
    const key = `cpi-test:leader-id:subscription-lock:${CATALYST_USER_ID}`;
    const lease = new RedisLeaderIdUserLease({
      redis,
      redisPrefix: 'cpi-test',
      leaseDurationMs: 1_000,
      renewEveryMs: 100,
      acquisitionWaitMs: 0,
    });

    await expect(
      lease.withLease(CATALYST_USER_ID, async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        redis.values.set(key, 'replacement-owner');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }),
    ).rejects.toMatchObject({ code: 'LEADER_ID_LOCK_LOST', statusCode: 409 });
    expect(redis.values.get(key)).toBe('replacement-owner');
  });
});

describe('production Leader-ID subscription reconciliation', () => {
  it('processes every verified binding sequentially and continues after a per-user failure', async () => {
    const calls: string[] = [];
    const onFailure = vi.fn();
    const summary = await reconcileLeaderIdSubscriptions({
      bindings: {
        listCatalystUserIds: vi.fn(async () => ['user-1', 'user-2', 'user-3']),
      },
      service: {
        subscribe: vi.fn(async (catalystUserId: string) => {
          calls.push(catalystUserId);
          if (catalystUserId === 'user-2') throw new Error('temporary failure');
        }),
      },
      onFailure,
    });

    expect(calls).toEqual(['user-1', 'user-2', 'user-3']);
    expect(summary).toEqual({
      totalBindings: 3,
      succeeded: 2,
      failed: 1,
    });
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
