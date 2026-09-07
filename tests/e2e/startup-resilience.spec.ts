import { expect, test } from '@playwright/test';
import { installCatalystApiMock } from './support/catalyst-api-mock';
import { installMessengerMock, messengerProviders } from './support/messenger-mock';

test.describe.configure({ mode: 'parallel' });

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  test.use({
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox'],
    },
  });
}

for (const provider of messengerProviders) {
  for (const failure of ['pending', 'failed'] as const) {
    test(`${provider} opens with ${failure} SDK using signed URL data`, async ({ page }) => {
      const mock = await installCatalystApiMock(page, provider);
      const sdkRequests: string[] = [];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(/https:\/\/(telegram\.org|st\.max\.ru)\/js\//, async (route) => {
        sdkRequests.push(new URL(route.request().url()).host);
        if (failure === 'pending') await gate;
        await route.abort('failed');
      });
      const dataKey = provider === 'telegram' ? 'tgWebAppData' : 'WebAppData';
      try {
        await page.goto(`/#${dataKey}=signed-url-test-data`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Встретимся в студии' })).toBeVisible();
        await expect.poll(() => sdkRequests.length).toBe(1);
        expect(sdkRequests).toEqual([provider === 'telegram' ? 'telegram.org' : 'st.max.ru']);
        expect(mock.state.calls.filter((call) => call.path === `/auth/${provider}`)).toHaveLength(
          1,
        );
        await expect(page.getByText('Кот подключается', { exact: true })).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally {
        release();
      }
    });
  }
}

test('a late Telegram SDK is initialized after the app has already opened', async ({ page }) => {
  await installCatalystApiMock(page, 'telegram');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://telegram.org/js/**', async (route) => {
    await gate;
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
      window.Telegram = {WebApp: {
        initData: 'signed-url-test-data', ready(){window.__lateSdkReady = true},
        expand(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){}
      }};
    `,
    });
  });
  try {
    await page.goto('/#tgWebAppData=signed-url-test-data', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Встретимся в студии' })).toBeVisible();
    release();
    await expect.poll(() => page.evaluate('Boolean(window.__lateSdkReady)')).toBe(true);
  } finally {
    release();
  }
});

test('an unsupported SDK initialization does not leave the cat loading', async ({ page }) => {
  await installMessengerMock(page, 'telegram');
  await page.addInitScript({
    content: 'window.Telegram.WebApp.ready = function(){throw new Error("Unsupported bridge")};',
  });
  await installCatalystApiMock(page, 'telegram');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Встретимся в студии' })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const path of ['/auth/telegram', '/auth/session', '/me']) {
  test(`a stalled ${path} times out and the retry opens the app`, async ({ page }) => {
    if (path !== '/auth/session') await installMessengerMock(page, 'telegram');
    await installCatalystApiMock(page, 'telegram');
    let intercepted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v1${path}`, async (route) => {
      if (intercepted) {
        if (path === '/auth/session') {
          return route.fulfill({
            json: {
              csrfToken: 'e2e-csrf',
              sessionToken: 'e2e-session',
              user: {
                id: '00000000-0000-4000-8000-000000000001',
                roles: ['participant'],
                profileComplete: true,
              },
            },
          });
        }
        return route.fallback();
      }
      intercepted = true;
      await gate;
      await route.abort('failed').catch(() => undefined);
    });
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => intercepted).toBe(true);
      await expect(page.getByText('Кот подключается', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Не удалось открыть приложение' }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('main[role="alert"]')).toContainText('15 секунд');
      release();
      await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Встретимся в студии' })).toBeVisible();
    } finally {
      release();
    }
  });
}
