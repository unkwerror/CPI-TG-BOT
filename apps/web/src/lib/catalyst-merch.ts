export type CatalystMerchKind =
  'ticket' | 'tee' | 'notebook' | 'shopper' | 'cardholder' | 'stickers' | 'writing';

export const catalystMerch = {
  ticket: {
    slug: 'catalyst-startup-lynch-pass',
    eyebrow: 'ДЛЯ КОМАНДЫ',
    line: 'Твоя идея. Главная сцена.',
    label: 'Всего 3 команды',
    images: [],
  },
  tee: {
    slug: 't-shirt-catalyst',
    eyebrow: 'WEAR YOUR IDEAS',
    line: 'Создавай. Носи.',
    label: 'Фирменный дроп',
    images: ['tee-dark-front.webp'],
  },
  notebook: {
    slug: 'catalyst-notebook',
    eyebrow: 'IDEA / LAB',
    line: 'Начни с чистого листа.',
    label: 'Тираж 50 шт.',
    images: ['notebook-catalog-v1.webp'],
  },
  shopper: {
    slug: 'catalyst-shopper',
    eyebrow: 'CARRY THE FUTURE',
    line: 'Всё своё. И ещё идея.',
    label: 'Тираж 50 шт.',
    images: ['shopper-catalog-v1.webp'],
  },
  cardholder: {
    slug: 'catalyst-cardholder',
    eyebrow: 'ACCESS / GRANTED',
    line: 'Твой пропуск в среду.',
    label: 'Каждый день с тобой',
    images: ['cardholder-catalog-v1.webp'],
  },
  stickers: {
    slug: 'catalyst-stickers',
    eyebrow: 'MAKE IT YOURS',
    line: 'Добавь характер.',
    label: 'Набор маскотов',
    images: ['stickers-catalog-v1.webp'],
  },
  writing: {
    slug: 'catalyst-pen-pencil',
    eyebrow: 'THINK → WRITE → BUILD',
    line: 'Большое начинается с наброска.',
    label: 'Ручка или карандаш',
    images: ['pen-catalog-v1.webp', 'pencil-catalog-v1.webp'],
  },
} satisfies Record<
  CatalystMerchKind,
  { slug: string; eyebrow: string; line: string; label: string; images: string[] }
>;

export function catalystMerchKind(product: {
  slug?: string;
  title: string;
}): CatalystMerchKind | null {
  for (const [kind, details] of Object.entries(catalystMerch)) {
    if (product.slug === details.slug) return kind as CatalystMerchKind;
  }
  return /футболк.*catalyst|catalyst.*футболк/iu.test(product.title) ? 'tee' : null;
}

export function catalystMerchImages(product: { slug?: string; title: string }) {
  const kind = catalystMerchKind(product);
  return kind
    ? catalystMerch[kind].images.map((file, index) => ({
        url: `/merch/${file}`,
        altText:
          kind === 'writing' ? (index ? 'Карандаш Catalyst' : 'Ручка Catalyst') : product.title,
      }))
    : [];
}
