const TELEGRAM_INIT_DATA_LIMIT = 16_384;
const TELEGRAM_STORAGE_KEY = '__telegram__initParams';

interface TelegramInitDataSources {
  sdkInitData?: string | null;
  hash?: string;
  search?: string;
  storedParams?: string | null;
}

function launchParameters(value: string): URLSearchParams {
  const withoutPrefix = value.replace(/^[#?]/, '');
  const queryIndex = withoutPrefix.indexOf('?');
  return new URLSearchParams(queryIndex >= 0 ? withoutPrefix.slice(queryIndex + 1) : withoutPrefix);
}

function usableInitData(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= TELEGRAM_INIT_DATA_LIMIT
    ? value
    : null;
}

export function extractTelegramInitData(sources: TelegramInitDataSources): string | null {
  const sdkValue = usableInitData(sources.sdkInitData);
  if (sdkValue) return sdkValue;

  for (const locationValue of [sources.hash ?? '', sources.search ?? '']) {
    const locationData = usableInitData(launchParameters(locationValue).get('tgWebAppData'));
    if (locationData) return locationData;
  }

  if (!sources.storedParams) return null;
  try {
    const stored = JSON.parse(sources.storedParams) as { tgWebAppData?: unknown };
    return usableInitData(stored.tgWebAppData);
  } catch {
    return null;
  }
}

export function getTelegramInitData(): string | null {
  let storedParams: string | null = null;
  try {
    storedParams = window.sessionStorage.getItem(TELEGRAM_STORAGE_KEY);
  } catch {
    // Some embedded browsers restrict sessionStorage. URL and SDK sources still work.
  }

  return extractTelegramInitData({
    sdkInitData: window.Telegram?.WebApp.initData ?? null,
    hash: window.location.hash,
    search: window.location.search,
    storedParams,
  });
}

export async function waitForTelegramInitData(timeoutMs = 3_000): Promise<string | null> {
  const immediate = getTelegramInitData();
  if (immediate) return immediate;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const initData = getTelegramInitData();
    if (initData) return initData;
  }
  return null;
}
