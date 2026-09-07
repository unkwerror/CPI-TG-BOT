import { expect, test } from '@playwright/test';
import { installCatalystApiMock } from './support/catalyst-api-mock';
import { installMessengerMock } from './support/messenger-mock';
import type { CoworkingBooking } from '../../apps/web/src/lib/coworking';

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  test.use({
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox'],
    },
  });
}
const product = {
  id: '00000000-0000-4000-8000-000000000020',
  slug: 't-shirt-catalyst',
  title: 'Футболка Catalyst с маскотом',
  description: null,
  descriptionFormat: 'text',
  cardHtml: null,
  cardPackageId: 'legacy-ignored',
  price: '250',
  status: 'published',
  kind: 'physical',
  stockMode: 'limited',
  available: 10,
  media: [],
  category: null,
};
async function prepare(page: Parameters<typeof installMessengerMock>[0], linked = true) {
  await installMessengerMock(page, 'telegram');
  const mock = await installCatalystApiMock(page, 'telegram');
  mock.state.linked = linked;
  mock.state.subscribed = linked;
  await page.route('**/api/v1/store/products?*', (route) =>
    route.fulfill({ json: { items: [product] } }),
  );
  return mock;
}
test('native merchandise keeps size and color on retry and makes no ZIP request', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await prepare(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?tab=store');
  const card = page.getByRole('button', { name: 'Открыть товар «Футболка Catalyst с маскотом»' });
  await expect(card).toBeVisible();
  await page.screenshot({ path: '/tmp/cpi-shop-mobile.png', fullPage: true });
  await card.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Футболка Catalyst с маскотом' })).toBeVisible();
  await dialog.getByRole('radio', { name: 'Светлый' }).check();
  await dialog.getByRole('radio', { name: 'XL', exact: true }).check();
  await dialog.getByRole('button', { name: '02 / Сзади' }).click();
  await expect(dialog.getByAltText('Светлая футболка Catalyst, сзади')).toBeVisible();
  await page.screenshot({ path: '/tmp/cpi-shirt-mobile.png', fullPage: true });
  mock.state.checkoutResponseLossesRemaining = 1;
  await dialog.getByRole('button', { name: 'Обменять баллы', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Обменять баллы', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Обменять баллы', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const calls = mock.state.calls.filter((c) => c.path === '/store/checkout');
  expect(calls).toHaveLength(2);
  expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  expect(calls[0]!.body).toMatchObject({ comment: 'Футболка Catalyst\nЦвет: Светлый\nРазмер: XL' });
  expect(mock.state.packageRenderCalls).toBe(0);
  expect(errors).toEqual([]);
});
test('linked users have no Leader-ID promo on home but can manage it in profile', async ({
  page,
}) => {
  await prepare(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Встретимся в студии' })).toBeVisible();
  await expect(page.locator('.wallet-leader-id-anchor')).toBeHidden();
  await expect(page.locator('.coworking-card')).toHaveCount(1);
  expect((await page.locator('.coworking-card').boundingBox())!.width).toBeLessThanOrEqual(280);
  await expect(page.getByRole('button', { name: 'Следующая карточка коворкинга' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/cpi-home-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Открыть профиль', exact: true }).click();
  await expect(page.locator('#leader-id-catalyst')).toBeVisible();
  await expect(page.locator('#leader-id-catalyst')).toContainText('Leader-ID');
});
test('unlinked users still see Leader-ID promotion', async ({ page }) => {
  await prepare(page, false);
  await page.goto('/');
  await expect(page.locator('.wallet-leader-id-anchor')).toBeVisible();
});
for (const width of [320, 1440]) {
  test(`one compact coworking button works without a carousel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepare(page);
    await page.goto('/');
    const section = page.locator('.coworking-section');
    const button = section.getByRole('button', { name: 'Оставить заявку на коворкинг' });
    await expect(section.getByRole('button')).toHaveCount(1);
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.width).toBeLessThanOrEqual(280);
    expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await section.screenshot({ path: `/tmp/cpi-compact-coworking-${width}.png` });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Место для твоего проекта' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(button).toBeFocused();
  });
}

test('coworking request reaches admin and review reaches the participant', async ({ page }) => {
  await prepare(page);
  const bookings: CoworkingBooking[] = [];
  const keys: string[] = [];
  let loseResponse = true;
  await page.route('**/api/v1/**coworking/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      keys.push(route.request().headers()['idempotency-key']!);
      if (!bookings.length)
        bookings.push({
          ...route.request().postDataJSON(),
          id: '00000000-0000-4000-8000-000000000777',
          status: 'pending',
          adminNote: null,
          createdAt: new Date().toISOString(),
          user: { id: 'test', fullName: 'Тестовый Участник', username: 'test', phone: null },
        });
      if (loseResponse) {
        loseResponse = false;
        return route.abort('failed');
      }
      return route.fulfill({ status: 201, json: bookings[0] });
    }
    if (route.request().method() === 'PATCH') {
      Object.assign(
        bookings[0]!,
        path.endsWith('/cancel') ? { status: 'cancelled' } : route.request().postDataJSON(),
      );
      return route.fulfill({ json: bookings[0] });
    }
    return route.fulfill({ json: { items: bookings, hasMore: false } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Оставить заявку на коворкинг', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Место для твоего проекта' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Участников').fill('4');
  await dialog.getByLabel('Чем планируете заниматься?').fill('Обсуждение проекта');
  await page.screenshot({ path: '/tmp/cpi-booking-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Отправить заявку ↗' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Отправить заявку ↗' }).click();
  await expect(page.getByRole('heading', { name: 'Заявка отправлена' })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(bookings).toHaveLength(1);
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      json: {
        id: '00000000-0000-4000-8000-000000000001',
        fullName: 'Администратор Тестовый Тестович',
        roles: ['admin'],
        profileComplete: true,
      },
    });
  });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Коворкинг', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тестовый Участник' })).toBeVisible();
  await page.getByLabel('Ответ участнику').fill('Ждём вас в студии');
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByText('Подтверждено', { exact: true }).last()).toBeVisible();
  expect(bookings[0]!.status).toBe('confirmed');
  await page.screenshot({ path: '/tmp/cpi-booking-admin.png', fullPage: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Оставить заявку на коворкинг', exact: true }).click();
  await expect(page.getByText('Ответ студии: Ждём вас в студии')).toBeVisible();
  await page.getByRole('button', { name: 'Отменить заявку', exact: true }).click();
  await expect(page.getByText('Отменено', { exact: true })).toBeVisible();
});
