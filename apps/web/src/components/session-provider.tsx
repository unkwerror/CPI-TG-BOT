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
import { initializeMessengerSafely } from '../lib/messenger-adapter';
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

  const refreshUser = useCallback(async (signal?: AbortSignal) => {
    const current = await api<CurrentUser>('/me', { signal: signal ?? null });
    if (!signal?.aborted) setUser(current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    // Bound the entire startup, including response bodies and loading /me after authentication.
    const timeout = window.setTimeout(() => {
      controller.abort();
      if (!disposed) {
        setError('Сервер не ответил за 15 секунд. Проверьте подключение и нажмите «Повторить».');
        setLoading(false);
      }
    }, 15_000);
    initializeMessengerSafely();
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    void (async () => {
      try {
        await authenticate(controller.signal);
        if (!controller.signal.aborted) await refreshUser(controller.signal);
      } catch (caught) {
        if (!disposed && !controller.signal.aborted) {
          setError(
            caught instanceof ApiClientError || caught instanceof Error
              ? caught.message
              : 'Не удалось авторизоваться',
          );
        }
      } finally {
        window.clearTimeout(timeout);
        if (!disposed && !controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
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
