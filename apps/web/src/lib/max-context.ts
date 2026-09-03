const MAX_INIT_DATA_LIMIT = 16_384;

interface MaxInitDataSources {
  sdkInitData?: string | null;
  hash?: string;
}

function usableInitData(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_INIT_DATA_LIMIT
    ? value
    : null;
}

export function extractMaxInitData(sources: MaxInitDataSources): string | null {
  const sdkValue = usableInitData(sources.sdkInitData);
  if (sdkValue) return sdkValue;
  const hash = new URLSearchParams((sources.hash ?? '').replace(/^#/u, ''));
  return usableInitData(hash.get('WebAppData'));
}

export function getMaxInitData(): string | null {
  return extractMaxInitData({
    sdkInitData: window.WebApp?.initData ?? null,
    hash: window.location.hash,
  });
}
