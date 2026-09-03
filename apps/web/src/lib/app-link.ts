export type InternalAppLink =
  | { destination: 'home' | 'events' | 'projects' | 'store' | 'history' | 'mine' | 'profile' }
  | { destination: 'event'; key: string }
  | { destination: 'product'; key: string };

const destinations = new Set(['home', 'events', 'projects', 'store', 'history', 'mine', 'profile']);

function decodedSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && decoded.length <= 160 ? decoded : null;
  } catch {
    return null;
  }
}

/** Parse API-managed links without allowing them to become arbitrary browser navigation. */
export function parseInternalAppLink(value: string, origin: string): InternalAppLink | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '#') return null;

  let url: URL;
  try {
    url = new URL(trimmed, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null;

  const tab = url.searchParams.get('tab');
  if (tab && destinations.has(tab)) {
    return { destination: tab as Exclude<InternalAppLink['destination'], 'event' | 'product'> };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { destination: 'home' };
  if (parts[0] === 'events') {
    const key = decodedSegment(parts[1]);
    return key ? { destination: 'event', key } : { destination: 'events' };
  }
  if (parts[0] === 'store') {
    const key = decodedSegment(parts[1] === 'products' ? parts[2] : parts[1]);
    return key ? { destination: 'product', key } : { destination: 'store' };
  }
  if (parts[0] === 'products') {
    const key = decodedSegment(parts[1]);
    return key ? { destination: 'product', key } : { destination: 'store' };
  }
  return destinations.has(parts[0]!)
    ? {
        destination: parts[0] as Exclude<InternalAppLink['destination'], 'event' | 'product'>,
      }
    : null;
}
