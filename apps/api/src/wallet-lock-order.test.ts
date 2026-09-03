import { describe, expect, it } from 'vitest';
import {
  lockWalletQrMutation,
  walletProgramLockKey,
  walletQrSessionLockKey,
} from './wallet-service';

function interpolatedString(query: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): string | null => {
    if (typeof value === 'string') return value.startsWith('wallet-') ? value : null;
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    for (const nested of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  const key = visit(query);
  if (key) return key;
  throw new Error('Expected an interpolated advisory-lock key');
}

class ExclusiveLocks {
  private tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

describe('wallet QR mutation lock order', () => {
  it('acquires the programme fence before the per-QR lock', async () => {
    const keys: string[] = [];
    const transaction = {
      execute: async (query: unknown) => {
        keys.push(interpolatedString(query));
      },
    };

    await lockWalletQrMutation(transaction as never, 'program-a', 'qr-a');

    expect(keys).toEqual([walletProgramLockKey('program-a'), walletQrSessionLockKey('qr-a')]);
  });

  it('serializes concurrent row-lock sections for the same QR session', async () => {
    const locks = new ExclusiveLocks();
    let active = 0;
    let maximumActive = 0;
    const trace: string[] = [];

    const mutate = async (name: string) => {
      const releases: Array<() => void> = [];
      const transaction = {
        execute: async (query: unknown) => {
          const key = interpolatedString(query);
          if (key.startsWith('wallet-qr-session:')) {
            releases.push(await locks.acquire(key));
          }
        },
      };
      await lockWalletQrMutation(transaction as never, 'program-a', 'qr-a');
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      trace.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      trace.push(`${name}:end`);
      active -= 1;
      for (const release of releases.reverse()) release();
    };

    await Promise.all([mutate('delete'), mutate('confirm')]);

    expect(maximumActive).toBe(1);
    expect(trace).toHaveLength(4);
    expect(trace.indexOf('delete:start')).toBeLessThan(trace.indexOf('delete:end'));
    expect(trace.indexOf('confirm:start')).toBeLessThan(trace.indexOf('confirm:end'));
  });
});
