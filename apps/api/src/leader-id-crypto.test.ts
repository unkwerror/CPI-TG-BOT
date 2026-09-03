import { describe, expect, it } from 'vitest';
import type { LeaderIdOAuthStateRecord, LeaderIdOAuthStateRepository } from './leader-id-contract';
import { AesGcmLeaderIdTokenCipher, SecureLeaderIdOAuthStateManager } from './leader-id-crypto';

class MemoryStateRepository implements LeaderIdOAuthStateRepository {
  readonly values = new Map<string, LeaderIdOAuthStateRecord>();

  async put(digest: string, value: LeaderIdOAuthStateRecord): Promise<void> {
    this.values.set(digest, value);
  }

  async take(digest: string): Promise<LeaderIdOAuthStateRecord | null> {
    const value = this.values.get(digest) ?? null;
    this.values.delete(digest);
    return value;
  }
}

describe('Leader-ID token encryption', () => {
  const cipher = new AesGcmLeaderIdTokenCipher({
    activeKeyId: 'primary',
    keys: { primary: Buffer.alloc(32, 7) },
  });

  it('round-trips a token set while binding it to the Catalyst user', () => {
    const envelope = cipher.encrypt(
      {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        leaderIdUserId: 606466,
        userValidated: true,
        expiresAt: '2026-08-28T10:00:00.000Z',
      },
      'catalyst-user-a',
    );

    expect(envelope).not.toContain('access-secret');
    expect(cipher.decrypt(envelope, 'catalyst-user-a')).toEqual({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      leaderIdUserId: 606466,
      userValidated: true,
      expiresAt: '2026-08-28T10:00:00.000Z',
    });
    expect(() => cipher.decrypt(envelope, 'catalyst-user-b')).toThrow();
  });

  it('rejects a modified authenticated envelope', () => {
    const envelope = cipher.encrypt({ accessToken: 'secret' }, 'catalyst-user');
    const last = envelope.at(-1);
    const tampered = `${envelope.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(() => cipher.decrypt(tampered, 'catalyst-user')).toThrow();
  });

  it('requires an exact 256-bit key', () => {
    expect(
      () =>
        new AesGcmLeaderIdTokenCipher({
          activeKeyId: 'bad',
          keys: { bad: Buffer.alloc(31) },
        }),
    ).toThrow(/32 bytes/u);
  });
});

describe('Leader-ID OAuth state', () => {
  it('stores only a digest and consumes state exactly once', async () => {
    const repository = new MemoryStateRepository();
    const manager = new SecureLeaderIdOAuthStateManager({
      repository,
      now: () => new Date('2026-08-28T05:00:00.000Z'),
      random: () => Buffer.alloc(32, 11),
    });

    const state = await manager.issue({
      catalystUserId: 'catalyst-user',
      expectedLeaderIdUserId: 12345,
    });

    expect(state).toHaveLength(43);
    expect([...repository.values.keys()]).not.toContain(state);
    await expect(manager.consume(state)).resolves.toMatchObject({
      catalystUserId: 'catalyst-user',
      expectedLeaderIdUserId: 12345,
    });
    await expect(manager.consume(state)).rejects.toMatchObject({
      code: 'LEADER_ID_OAUTH_STATE_INVALID',
    });
  });

  it('rejects an expired state after atomically removing it', async () => {
    const repository = new MemoryStateRepository();
    let now = new Date('2026-08-28T05:00:00.000Z');
    const manager = new SecureLeaderIdOAuthStateManager({
      repository,
      ttlSeconds: 60,
      now: () => now,
      random: () => Buffer.alloc(32, 12),
    });
    const state = await manager.issue({
      catalystUserId: 'catalyst-user',
      expectedLeaderIdUserId: 42,
    });
    now = new Date('2026-08-28T05:02:00.000Z');
    await expect(manager.consume(state)).rejects.toMatchObject({
      code: 'LEADER_ID_OAUTH_STATE_EXPIRED',
    });
    await expect(manager.consume(state)).rejects.toMatchObject({
      code: 'LEADER_ID_OAUTH_STATE_INVALID',
    });
  });
});
