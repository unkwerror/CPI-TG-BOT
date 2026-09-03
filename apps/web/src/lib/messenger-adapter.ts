import { getMessengerLaunchData, type MessengerProvider } from './messenger-context';

export type MessengerContactResult =
  | { mode: 'bot'; shared: boolean }
  | {
      mode: 'signed';
      contact: { phone: string; authDate: string; hash: string };
    };

export interface MessengerAdapter {
  readonly provider: MessengerProvider;
  initialize(): void;
  getStartParameter(): string | undefined;
  getTheme(): 'light' | 'dark';
  openLink(url: string): boolean;
  downloadFile(url: string, fileName: string): boolean;
  supportsQrScanner(): boolean;
  requestContact(): Promise<MessengerContactResult>;
  scanQr(options?: { prompt?: string; fileSelect?: boolean }): Promise<string | null>;
  closeQrScanner(): void;
  setClosingConfirmation(enabled: boolean): void;
  notify(type: 'error' | 'success' | 'warning'): void;
  close(): void;
}

function browserTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/u;
const TELEGRAM_INVITE = /^[A-Za-z0-9_-]{8,128}$/u;

function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * External destinations can come from API-managed content. Normalize them once before
 * handing them to a messenger bridge or the browser so active URL schemes never execute.
 */
export function normalizeExternalUrl(value: string): string | null {
  const trimmed = value.trim();
  if (/^tg:\/\//iu.test(trimmed)) {
    try {
      const telegramUrl = new URL(trimmed);
      if (telegramUrl.hostname === 'resolve') {
        const domain = telegramUrl.searchParams.get('domain') ?? '';
        if (!TELEGRAM_USERNAME.test(domain)) return null;
        const target = new URL(`https://t.me/${domain}`);
        for (const key of ['start', 'startapp', 'thread']) {
          const parameter = telegramUrl.searchParams.get(key);
          if (parameter) target.searchParams.set(key, parameter.slice(0, 256));
        }
        return target.toString();
      }
      if (telegramUrl.hostname === 'join') {
        const invite = telegramUrl.searchParams.get('invite') ?? '';
        return TELEGRAM_INVITE.test(invite) ? `https://t.me/+${invite}` : null;
      }
      return null;
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(trimmed);
    if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function browserOpen(url: string): boolean {
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) {
      opened.opener = null;
      return true;
    }
    window.location.assign(url);
    return true;
  } catch {
    return false;
  }
}

function safeFileName(value: string): string {
  const normalized = value.replaceAll(/[\r\n/\\]/gu, ' ').trim();
  return normalized.slice(0, 180) || 'download';
}

function hasCallableProperty(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, key) === 'function'
  );
}

function cssLength(value: string): string | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?(?:px)?$/u.test(normalized)) return null;
  return normalized.endsWith('px') ? normalized : `${normalized}px`;
}

const telegramAdapter: MessengerAdapter = {
  provider: 'telegram',
  initialize() {
    const telegram = window.Telegram?.WebApp;
    telegram?.ready();
    telegram?.expand();
    telegram?.setHeaderColor?.('#080808');
    telegram?.setBackgroundColor?.('#080808');
    telegram?.setBottomBarColor?.('#080808');
  },
  getStartParameter: () => window.Telegram?.WebApp.initDataUnsafe?.start_param,
  getTheme: () => window.Telegram?.WebApp.colorScheme ?? browserTheme(),
  openLink(url) {
    const normalized = normalizeExternalUrl(url);
    if (!normalized) return false;
    try {
      const parsed = new URL(normalized);
      if (
        window.Telegram?.WebApp.openTelegramLink &&
        (isHostOrSubdomain(parsed.hostname, 't.me') ||
          isHostOrSubdomain(parsed.hostname, 'telegram.me'))
      ) {
        window.Telegram.WebApp.openTelegramLink(parsed.toString());
        return true;
      }
      if (window.Telegram?.WebApp.openLink) {
        window.Telegram.WebApp.openLink(parsed.toString());
        return true;
      }
      return browserOpen(parsed.toString());
    } catch {
      // A bridge can be present but unavailable in an older WebView. The URL has already
      // passed validation, so the browser fallback is safe.
      return browserOpen(normalized);
    }
  },
  downloadFile(url) {
    return telegramAdapter.openLink(url);
  },
  supportsQrScanner: () => hasCallableProperty(window.Telegram?.WebApp, 'showScanQrPopup'),
  requestContact() {
    const telegram = window.Telegram?.WebApp;
    if (!telegram?.requestContact) return Promise.resolve({ mode: 'bot', shared: false });
    return new Promise((resolve, reject) => {
      try {
        telegram.requestContact?.((shared) => resolve({ mode: 'bot', shared }));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  },
  scanQr(options) {
    const telegram = window.Telegram?.WebApp;
    if (!telegram?.showScanQrPopup) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      try {
        telegram.showScanQrPopup?.(
          { text: options?.prompt ?? 'Наведите камеру на QR-код' },
          (data) => {
            telegram.closeScanQrPopup?.();
            resolve(data);
            return true;
          },
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  },
  closeQrScanner() {
    try {
      window.Telegram?.WebApp.closeScanQrPopup?.();
    } catch {
      // Older Telegram WebViews can expose the method without supporting the popup API.
    }
  },
  setClosingConfirmation(enabled) {
    if (enabled) window.Telegram?.WebApp.enableClosingConfirmation?.();
    else window.Telegram?.WebApp.disableClosingConfirmation?.();
  },
  notify(type) {
    window.Telegram?.WebApp.HapticFeedback?.notificationOccurred(type);
  },
  close() {
    window.Telegram?.WebApp.close();
  },
};

const maxAdapter: MessengerAdapter = {
  provider: 'max',
  initialize() {
    void window.WebApp?.getViewportSize?.().then(({ height, width }) => {
      const safeHeight = cssLength(height);
      const safeWidth = cssLength(width);
      if (safeHeight)
        document.documentElement.style.setProperty('--max-viewport-height', safeHeight);
      if (safeWidth) document.documentElement.style.setProperty('--max-viewport-width', safeWidth);
    });
  },
  getStartParameter: () => window.WebApp?.initDataUnsafe?.start_param,
  getTheme: browserTheme,
  openLink(url) {
    const normalized = normalizeExternalUrl(url);
    if (!normalized) return false;
    try {
      const parsed = new URL(normalized);
      if (window.WebApp?.openMaxLink && isHostOrSubdomain(parsed.hostname, 'max.ru')) {
        window.WebApp.openMaxLink(parsed.toString());
        return true;
      }
      if (window.WebApp?.openLink) {
        window.WebApp.openLink(parsed.toString());
        return true;
      }
      return browserOpen(parsed.toString());
    } catch {
      return browserOpen(normalized);
    }
  },
  downloadFile(url, fileName) {
    const normalized = normalizeExternalUrl(url);
    if (!normalized) return false;
    try {
      if (window.WebApp?.downloadFile) {
        window.WebApp.downloadFile(normalized, safeFileName(fileName));
        return true;
      }
    } catch {
      // A partially implemented bridge should fall back to the regular link action.
    }
    return maxAdapter.openLink(normalized);
  },
  supportsQrScanner: () => hasCallableProperty(window.WebApp, 'openCodeReader'),
  async requestContact() {
    const max = window.WebApp;
    if (!max?.requestContact) throw new Error('Эта версия MAX не поддерживает передачу номера');
    return { mode: 'signed', contact: await max.requestContact() };
  },
  async scanQr(options) {
    const max = window.WebApp;
    return max?.openCodeReader ? max.openCodeReader(options?.fileSelect ?? true) : null;
  },
  closeQrScanner() {
    // The current MAX Bridge contract does not expose a scanner cancellation method.
  },
  setClosingConfirmation(enabled) {
    if (enabled) window.WebApp?.enableClosingConfirmation?.();
    else window.WebApp?.disableClosingConfirmation?.();
  },
  notify(type) {
    window.WebApp?.HapticFeedback?.notificationOccurred(type);
  },
  close() {
    // The current MAX Bridge contract has no general close() method.
  },
};

export function getMessengerAdapter(provider?: MessengerProvider): MessengerAdapter | null {
  const resolved = provider ?? getMessengerLaunchData()?.provider;
  if (resolved === 'max') return maxAdapter;
  if (resolved === 'telegram') return telegramAdapter;
  return null;
}

export function openExternalLink(value: string, provider?: MessengerProvider): boolean {
  const normalized = normalizeExternalUrl(value);
  if (!normalized) return false;
  const adapter = getMessengerAdapter(provider);
  if (adapter) return adapter.openLink(normalized);
  return browserOpen(normalized);
}

export function downloadMessengerFile(
  value: string,
  fileName: string,
  provider?: MessengerProvider,
): boolean {
  const normalized = normalizeExternalUrl(value);
  if (!normalized) return false;
  const adapter = getMessengerAdapter(provider);
  if (adapter) return adapter.downloadFile(normalized, fileName);
  return browserOpen(normalized);
}
