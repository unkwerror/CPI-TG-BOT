export type RichContentFormat = 'text' | 'html';

const entities: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  raquo: '»',
};

/** Produces a readable card excerpt without ever injecting source markup into the DOM. */
export function richContentToText(
  value: string | null | undefined,
  format: RichContentFormat | undefined,
): string {
  if (!value) return '';
  if (format !== 'html') return value.trim();
  return value
    .replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x')) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return entities[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
