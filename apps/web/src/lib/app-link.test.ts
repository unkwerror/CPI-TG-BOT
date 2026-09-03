import { describe, expect, it } from 'vitest';
import { parseInternalAppLink } from './app-link';

const origin = 'https://app.catalyst.example';

describe('parseInternalAppLink', () => {
  it.each([
    ['/events', { destination: 'events' }],
    ['/events/606466', { destination: 'event', key: '606466' }],
    ['/store', { destination: 'store' }],
    ['/store/products/cat-shirt', { destination: 'product', key: 'cat-shirt' }],
    ['/products/product-id', { destination: 'product', key: 'product-id' }],
    ['/projects', { destination: 'projects' }],
    ['/?tab=mine', { destination: 'mine' }],
  ])('maps %s to its participant destination', (value, expected) => {
    expect(parseInternalAppLink(value, origin)).toEqual(expected);
  });

  it.each(['https://attacker.example/store', 'javascript:alert(1)', '/unknown/path', '#'])(
    'rejects non-app destination %s',
    (value) => {
      expect(parseInternalAppLink(value, origin)).toBeNull();
    },
  );
});
