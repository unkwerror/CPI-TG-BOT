import { expect, test } from '@playwright/test';

const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const reactDevelopmentCspWarning = 'eval() is not supported in this environment.';

if (browserExecutable) {
  test.use({
    launchOptions: {
      executablePath: browserExecutable,
      args: ['--disable-crash-reporter', '--disable-crashpad'],
    },
  });
}

test.beforeEach(async ({ page }) => {
  await page.route(/https:\/\/(?:telegram\.org|st\.max\.ru)\//u, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
});

test('public Leader-ID completion page renders success without messenger auth', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const authRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(reactDevelopmentCspWarning)) {
      consoleErrors.push(message.text());
    }
  });
  page.on('request', (request) => {
    if (/\/api\/v1\/auth\//u.test(new URL(request.url()).pathname)) {
      authRequests.push(request.url());
    }
  });

  await page.goto('/leader-id/complete?leaderId=linked');

  await expect(page).toHaveTitle('Подключение Leader-ID — Catalyst');
  await expect(page.locator('main')).toHaveAttribute('data-leader-id-result', 'linked');
  await expect(page.getByRole('heading', { name: 'Leader-ID подключён' })).toBeVisible();
  await expect(page.getByText('Эту страницу можно закрыть.', { exact: false })).toBeVisible();
  await page.getByText('Если статус не обновился', { exact: true }).click();
  await expect(page.getByText('Повторно регистрироваться в Leader-ID не нужно.')).toBeVisible();
  await expect(page.getByText(/Application error|Build Error|Runtime Error/u)).toHaveCount(0);
  expect(authRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('public Leader-ID completion page fails closed to a generic error state', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(reactDevelopmentCspWarning)) {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/leader-id/complete?leaderId=%3Cscript%3Ealert(1)%3C%2Fscript%3E');

  await expect(page.locator('main')).toHaveAttribute('data-leader-id-result', 'error');
  await expect(
    page.getByRole('heading', { name: 'Не удалось подключить Leader-ID' }),
  ).toBeVisible();
  await expect(page.getByText('alert(1)', { exact: false })).toHaveCount(0);
  await page.getByText('Что можно проверить', { exact: true }).click();
  await expect(
    page.getByText('разрешите запрошенный доступ Leader-ID', { exact: false }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
