'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import type { WalletSummary } from '../lib/wallet-types';

const integerFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

function asBigInt(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : 0n;
  return /^-?\d+$/.test(value.trim()) ? BigInt(value.trim()) : 0n;
}

export function formatWalletAmount(value: string | number | bigint): string {
  return integerFormatter.format(asBigInt(value));
}

interface WalletProgramContextValue {
  summary: WalletSummary | null;
  loading: boolean;
  error: string | null;
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  applyDelta: (delta: string | number | bigint) => void;
  unitFor: (value: string | number | bigint) => string;
  withUnit: (value: string | number | bigint) => string;
}

const WalletProgramContext = createContext<WalletProgramContextValue | null>(null);

export function WalletProgramProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      setSummary(await api<WalletSummary>('/wallet'));
      setError(null);
    } catch (caught) {
      if (!options?.silent) {
        setError(caught instanceof Error ? caught.message : 'Кошелёк пока недоступен');
      }
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, []);

  const applyDelta = useCallback((delta: string | number | bigint) => {
    setSummary((current) => {
      if (!current) return current;
      const next = asBigInt(current.account.balance) + asBigInt(delta);
      if (next < 0n) return current;
      return {
        ...current,
        account: { ...current.account, balance: next.toString() },
      };
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  const value = useMemo<WalletProgramContextValue>(() => {
    const unitFor = (amount: string | number | bigint) => {
      const absolute = asBigInt(amount) < 0n ? -asBigInt(amount) : asBigInt(amount);
      const lastTwo = absolute % 100n;
      const last = absolute % 10n;
      if (lastTwo >= 11n && lastTwo <= 14n) return summary?.program.unitMany ?? 'баллов';
      if (last === 1n) return summary?.program.unitOne ?? 'балл';
      if (last >= 2n && last <= 4n) return summary?.program.unitFew ?? 'балла';
      return summary?.program.unitMany ?? 'баллов';
    };
    return {
      summary,
      loading,
      error,
      refresh,
      applyDelta,
      unitFor,
      withUnit: (amount) => `${formatWalletAmount(amount)} ${unitFor(amount)}`,
    };
  }, [applyDelta, error, loading, refresh, summary]);

  return <WalletProgramContext.Provider value={value}>{children}</WalletProgramContext.Provider>;
}

export function useWalletProgram(): WalletProgramContextValue {
  const value = useContext(WalletProgramContext);
  if (!value)
    throw new Error('useWalletProgram должен использоваться внутри WalletProgramProvider');
  return value;
}
