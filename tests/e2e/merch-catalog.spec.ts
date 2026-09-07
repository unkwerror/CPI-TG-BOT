import { expect, test } from '@playwright/test';
import { installCatalystApiMock } from './support/catalyst-api-mock';
import { installMessengerMock, type MessengerProvider } from './support/messenger-mock';
import { catalystMerch } from '../../apps/web/src/lib/catalyst-merch';
import catalog from '../../scripts/catalog/catalyst-20260907.json' with { type: 'json' };

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
  test.use({
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox'],
    },
  });
async function prepare(
  page: Parameters<typeof installMessengerMock>[0],
  provider: MessengerProvider,
  outOfStock = false,
) {
  await installMessengerMock(page, provider);
  const mock = await installCatalystApiMock(page, provider);
  await page.route('**/api/v1/store/products?*', (route) =>
    route.fulfill({
      json: {
        items: catalog.map((p, i) => ({
          id: '00000000-0000-4000-8000-' + String(i + 20).padStart(12, '0'),
          slug: p.slug,
          title: p.title,
          price: String(p.price),
          description: p.description,
          status: 'published',
          kind: 'physical',
          stockMode: 'limited',
          available: outOfStock ? 0 : (p.stock ?? 9),
          coverUrl: p.files[0] ? '/merch/' + p.files[0] : null,
          category: { id: p.category, slug: p.category, title: p.category },
          media: [],
          cardHtml: '<p>Legacy card must not render</p>',
          cardPackageId: 'legacy-ignored',
        })),
      },
    }),
  );
  return mock;
}
for (const [width, provider] of [
  [320, 'telegram'],
  [390, 'max'],
  [1440, 'telegram'],
] as const) {
  test('seven distinct merch designs at ' + width + ' in ' + provider, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await prepare(page, provider);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/?tab=store');
    await expect(page.locator('.merch-card')).toHaveCount(7);
    for (const [kind, design] of Object.entries(catalystMerch)) {
      const item = catalog.find((p) => p.slug === design.slug)!;
      const card = page.locator('.merch-card--' + kind);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toContainText(item.title);
      expect((await card.innerText()).replace(/\s/g, '')).toContain(String(item.price));
      for (const img of await card.locator('img').all())
        await expect
          .poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth))
          .toBeGreaterThan(0);
      await card.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
      if (kind === 'ticket') {
        await expect(dialog.getByText('Одна проходка — для всей команды')).toBeVisible();
        await expect(
          dialog.getByRole('button', { name: 'Обменять баллы', exact: true }),
        ).toHaveCount(0);
      }
      if (kind === 'notebook' || kind === 'stickers' || kind === 'writing')
        await dialog.screenshot({ path: '/tmp/catalyst-merch-' + kind + '-' + width + '.png' });
      await dialog.getByRole('button', { name: 'Закрыть товар', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.entity-action-dock--product')).toHaveCount(0);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: '/tmp/catalyst-catalog-' + width + '.png', fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(mock.state.packageRenderCalls).toBe(0);
    expect(errors).toEqual([]);
  });
}
test('writing choice survives response loss and last unit is unavailable', async ({ page }) => {
  const mock = await prepare(page, 'telegram');
  await page.goto('/?tab=store');
  await page.locator('.merch-card--writing').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Карандаш', exact: true }).check();
  await expect(dialog.getByAltText('Карандаш Catalyst', { exact: true })).toBeVisible();
  mock.state.checkoutResponseLossesRemaining = 1;
  await dialog.getByRole('button', { name: 'Обменять баллы', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Обменять баллы', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Обменять баллы', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const calls = mock.state.calls.filter((c) => c.path === '/store/checkout');
  expect(calls).toHaveLength(2);
  expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  expect(calls[0]!.body).toMatchObject({ comment: 'Catalyst\nВариант: Карандаш' });
  await expect(page.locator('.merch-card--writing')).toContainText('Доступно: 8 шт.');
});
test('no personal purchase of team pass or unavailable goods', async ({ page }) => {
  const mock = await prepare(page, 'telegram', true);
  await page.goto('/?tab=store');
  await page.locator('.merch-card--ticket').click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Обсудить с организаторами', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Обсудить с организаторами', exact: true }).click();
  await dialog.getByRole('button', { name: 'Закрыть товар', exact: true }).click();
  await page.locator('.merch-card--cardholder').click();
  await expect(
    dialog.getByRole('button', { name: 'Сейчас недоступно', exact: true }),
  ).toBeDisabled();
  expect(mock.state.calls.filter((c) => c.path === '/store/checkout')).toHaveLength(0);
});
