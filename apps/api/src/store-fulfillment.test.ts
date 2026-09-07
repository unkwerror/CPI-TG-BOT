import { expect, it } from 'vitest';
import { assertPersonalCheckoutAllowed } from './store-fulfillment';

it('rejects personal checkout for the team-only pass', () => {
  expect(() => assertPersonalCheckoutAllowed({ slug: 'catalyst-startup-lynch-pass' })).toThrow(
    /командными баллами/,
  );
});
it('allows regular merch checkout', () => {
  for (const slug of [
    't-shirt-catalyst',
    'catalyst-notebook',
    'catalyst-shopper',
    'catalyst-cardholder',
    'catalyst-stickers',
    'catalyst-pen-pencil',
    'another-product',
  ]) {
    expect(() => assertPersonalCheckoutAllowed({ slug })).not.toThrow();
  }
});
