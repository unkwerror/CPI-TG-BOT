import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, saveAuthSession, setCsrfToken } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('auth session storage fallback', () => {
  it('keeps authentication usable when an embedded browser denies sessionStorage', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: vi.fn(() => {
          throw new DOMException('denied', 'SecurityError');
        }),
        setItem: vi.fn(() => {
          throw new DOMException('denied', 'SecurityError');
        }),
      },
    });

    expect(() => setCsrfToken('csrf')).not.toThrow();
    expect(() =>
      saveAuthSession({ csrfToken: 'csrf-next', sessionToken: 'session', user: {} as never }),
    ).not.toThrow();
  });
});

describe('cancellable login', () => {
  it.each(['telegram', 'max'])('passes cancellation to %s authentication', async (provider) => {
    const setItem = vi.fn();
    vi.stubGlobal('window', {
      location: { hash: '', search: '' },
      sessionStorage: { getItem: () => null, setItem },
      ...(provider === 'telegram'
        ? { Telegram: { WebApp: { initData: 'signed-launch' } } }
        : { WebApp: { initData: 'signed-launch' } }),
    });
    const controller = new AbortController();
    const fetch = vi.fn(async () =>
      Response.json({ csrfToken: 'csrf', sessionToken: 'session', user: {} }),
    );
    vi.stubGlobal('fetch', fetch);
    await authenticate(controller.signal);
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/auth/${provider}`,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(setItem).toHaveBeenCalledWith('sessionToken', 'session');
  });

  it.each(['reject', 'resolve'])(
    'does not save a late/aborted response body (%s)',
    async (outcome) => {
      const setItem = vi.fn();
      vi.stubGlobal('window', {
        location: { hash: '', search: '' },
        sessionStorage: { getItem: () => null, setItem },
        Telegram: { WebApp: { initData: 'signed-launch' } },
      });
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            controller.abort();
            if (outcome === 'reject') throw new DOMException('Aborted', 'AbortError');
            return { csrfToken: 'late-csrf', sessionToken: 'late-session', user: {} };
          },
        })),
      );
      await expect(authenticate(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(setItem).not.toHaveBeenCalled();
    },
  );
});
