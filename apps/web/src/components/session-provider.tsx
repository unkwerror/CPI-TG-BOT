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
import { api, ApiClientError, authenticate } from '../lib/api';
import type { CurrentUser } from '../lib/types';

interface SessionContextValue {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
  online: boolean;
  refreshUser: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  const refreshUser = useCallback(async () => {
    const current = await api<CurrentUser>('/me');
    setUser(current);
  }, []);

  useEffect(() => {
    const telegram = window.Telegram?.WebApp;
    telegram?.ready();
    telegram?.expand();
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    void (async () => {
      try {
        await authenticate();
        await refreshUser();
      } catch (caught) {
        setError(
          caught instanceof ApiClientError || caught instanceof Error
            ? caught.message
            : 'Не удалось авторизоваться',
        );
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      window.removeEventListener('online', markOnline);
      window.removeEventListener('offline', markOffline);
    };
  }, [refreshUser]);

  const value = useMemo(
    () => ({ user, loading, error, online, refreshUser }),
    [user, loading, error, online, refreshUser],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
