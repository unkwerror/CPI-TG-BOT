import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMessengerAdapter,
  initializeMessengerSafely,
  normalizeExternalUrl,
} from './messenger-adapter';

function installWindow(value: Record<string, unknown>): void {
  vi.stubGlobal('window', value);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeExternalUrl', () => {
  it('normalizes HTTP(S) destinations', () => {
    expect(normalizeExternalUrl('https://leader-id.ru/events/606466')).toBe(
      'https://leader-id.ru/events/606466',
    );
    expect(normalizeExternalUrl('http://localhost:3000/path')).toBe('http://localhost:3000/path');
    expect(normalizeExternalUrl('tg://resolve?domain=catalyst_bot&start=event_1')).toBe(
      'https://t.me/catalyst_bot?start=event_1',
    );
    expect(normalizeExternalUrl('tg://join?invite=AbCdEfGh12')).toBe('https://t.me/+AbCdEfGh12');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'tg://resolve?domain=x',
    'tg://resolve?domain=catalyst_bot%2Fbad',
    'tg://user?id=123',
    '//example.com/path',
    '/relative/path',
    'not a URL',
    'https://user:password@example.com/private',
  ])('rejects unsafe or ambiguous destination %s', (value) => {
    expect(normalizeExternalUrl(value)).toBeNull();
  });
});

describe('Telegram messenger adapter', () => {
  it('initializes each SDK instance once, including one loaded later', () => {
    const ready = vi.fn();
    installWindow({ Telegram: { WebApp: { ready, expand: vi.fn() } } });
    initializeMessengerSafely('telegram');
    initializeMessengerSafely('telegram');
    expect(ready).toHaveBeenCalledOnce();
    const lateReady = vi.fn();
    installWindow({ Telegram: { WebApp: { ready: lateReady, expand: vi.fn() } } });
    initializeMessengerSafely('telegram');
    expect(lateReady).toHaveBeenCalledOnce();
  });
  it('does not make login depend on SDK initialization', () => {
    installWindow({});
    expect(() => initializeMessengerSafely('telegram')).not.toThrow();
    installWindow({
      Telegram: {
        WebApp: {
          ready: () => {
            throw new Error('Unsupported bridge');
          },
        },
      },
    });
    expect(() => initializeMessengerSafely('telegram')).not.toThrow();
  });
  it('routes trusted Telegram hosts to openTelegramLink and other HTTPS URLs to openLink', () => {
    const openTelegramLink = vi.fn();
    const openLink = vi.fn();
    const browserOpen = vi.fn(() => null);
    installWindow({
      open: browserOpen,
      Telegram: {
        WebApp: {
          openTelegramLink,
          openLink,
        },
      },
    });

    const adapter = getMessengerAdapter('telegram');
    expect(adapter?.openLink('https://t.me/catalyst')).toBe(true);
    expect(adapter?.openLink('https://sub.telegram.me/catalyst')).toBe(true);
    expect(adapter?.openLink('https://leader-id.ru/events/606466')).toBe(true);
    expect(adapter?.openLink('javascript:alert(1)')).toBe(false);

    expect(openTelegramLink).toHaveBeenCalledTimes(2);
    expect(openLink).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith('https://leader-id.ru/events/606466');
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('returns scanned data and owns Telegram popup cleanup', async () => {
    const closeScanQrPopup = vi.fn();
    const showScanQrPopup = vi.fn(
      (options: { text?: string }, callback: (data: string) => boolean | void) => {
        expect(options.text).toBe('Сканируйте код');
        callback('wallet:token');
      },
    );
    installWindow({
      open: vi.fn(() => null),
      Telegram: { WebApp: { showScanQrPopup, closeScanQrPopup } },
    });

    const adapter = getMessengerAdapter('telegram');
    await expect(adapter?.scanQr({ prompt: 'Сканируйте код' })).resolves.toBe('wallet:token');
    expect(closeScanQrPopup).toHaveBeenCalledOnce();

    adapter?.closeQrScanner();
    expect(closeScanQrPopup).toHaveBeenCalledTimes(2);
  });
});

describe('MAX messenger adapter', () => {
  it('handles rejected viewport initialization without blocking login', async () => {
    installWindow({
      WebApp: { getViewportSize: () => Promise.reject(new Error('Bridge unavailable')) },
    });
    expect(() => initializeMessengerSafely('max')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
  it('routes only MAX-owned hosts to openMaxLink', () => {
    const openMaxLink = vi.fn();
    const openLink = vi.fn();
    installWindow({
      open: vi.fn(() => null),
      WebApp: { openMaxLink, openLink },
    });

    const adapter = getMessengerAdapter('max');
    expect(adapter?.openLink('https://max.ru/catalyst')).toBe(true);
    expect(adapter?.openLink('https://community.max.ru/catalyst')).toBe(true);
    expect(adapter?.openLink('https://max.ru.attacker.example/catalyst')).toBe(true);
    expect(adapter?.openLink('data:text/html,unsafe')).toBe(false);

    expect(openMaxLink).toHaveBeenCalledTimes(2);
    expect(openLink).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith('https://max.ru.attacker.example/catalyst');
  });

  it('uses the MAX code reader and forwards its file-selection capability', async () => {
    const openCodeReader = vi.fn(async () => 'max:wallet-token');
    installWindow({ open: vi.fn(() => null), WebApp: { openCodeReader } });

    const adapter = getMessengerAdapter('max');
    await expect(adapter?.scanQr({ fileSelect: false })).resolves.toBe('max:wallet-token');
    expect(openCodeReader).toHaveBeenCalledWith(false);
  });

  it('uses the MAX download bridge with a sanitized file name', () => {
    const downloadFile = vi.fn();
    installWindow({ open: vi.fn(() => null), WebApp: { downloadFile } });

    const adapter = getMessengerAdapter('max');
    expect(adapter?.downloadFile('https://cdn.example/report.pdf', '../report\n.pdf')).toBe(true);
    expect(downloadFile).toHaveBeenCalledWith('https://cdn.example/report.pdf', '.. report .pdf');
  });
});
