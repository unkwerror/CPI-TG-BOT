import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveAuthSession, setCsrfToken } from './api';

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
