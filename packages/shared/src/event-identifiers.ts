const transliteration: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function transliterateTitle(value: string): string {
  return [...value.toLocaleLowerCase('ru-RU')]
    .map((character) => transliteration[character] ?? character)
    .join('');
}

export function eventSlugFromTitle(title: string): string {
  const slug = transliterateTitle(title)
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 100)
    .replaceAll(/-+$/g, '');
  return slug || 'event';
}

export function eventShortCodeFromTitle(title: string): string {
  const code = eventSlugFromTitle(title).replaceAll('-', '_').toUpperCase().slice(0, 24);
  return code.length >= 3 ? code : 'EVENT';
}
