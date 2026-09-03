import { expect, test } from '@playwright/test';
import { installMessengerMock } from './support/messenger-mock';

const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (browserExecutable) {
  test.use({
    launchOptions: {
      executablePath: browserExecutable,
      args: ['--disable-crash-reporter', '--disable-crashpad'],
    },
  });
}

test('админка отличает подтверждённый Leader-ID от неподключённого', async ({ page }) => {
  await installMessengerMock(page, 'telegram');
  const admin = {
    id: '00000000-0000-4000-8000-000000000001',
    telegramUserId: '700001',
    messengerProvider: 'telegram',
    messengerUserId: '700001',
    telegramUsername: 'admin_e2e',
    fullName: 'Администратор Тестов Катализаторович',
    organization: 'НГУ',
    position: 'Администратор',
    phone: '+70000000000',
    consentAt: '2026-08-28T00:00:00.000Z',
    roles: ['admin'],
    profileComplete: true,
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/u, '');
    const fulfill = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'POST' && path === '/auth/telegram') {
      return fulfill({
        user: admin,
        csrfToken: 'admin-csrf-e2e',
        sessionToken: 'admin-session-e2e',
      });
    }
    if (request.method() === 'GET' && path === '/me') return fulfill(admin);
    if (request.method() === 'GET' && path === '/admin/dashboard') {
      return fulfill({
        activeEvents: 0,
        participants: 0,
        submissions: 0,
        artifacts: 0,
        storageBytes: 0,
        failedUploads: 0,
        latestUploads: [],
      });
    }
    if (request.method() === 'GET' && path === '/admin/users') {
      const base = {
        telegramUserId: '700002',
        telegramUsername: 'participant_e2e',
        phone: null,
        organization: 'НГУ',
        position: 'Участник',
        status: 'active',
        submissionCount: 0,
        artifactCount: 0,
        totalBytes: 0,
        createdAt: '2026-08-28T00:00:00.000Z',
        lastSeenAt: '2026-08-28T00:00:00.000Z',
        joinedAt: null,
        lastSubmissionAt: null,
      };
      return fulfill({
        items: [
          {
            ...base,
            id: '00000000-0000-4000-8000-000000000002',
            fullName: 'Лидеров Лев Леонидович',
            leaderId: {
              status: 'linked',
              userId: 123456,
              linkedAt: '2026-08-28T00:00:00.000Z',
            },
          },
          {
            ...base,
            id: '00000000-0000-4000-8000-000000000003',
            fullName: null,
            leaderId: { status: 'not_linked' },
          },
        ],
        nextCursor: null,
      });
    }
    return route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'E2E_UNMOCKED', message: `${request.method()} ${path}` },
      }),
    });
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Пользователи' }).click();

  await expect(page.getByRole('columnheader', { name: 'Leader-ID' })).toBeVisible();
  await expect(page.getByText('Подтверждён', { exact: true })).toBeVisible();
  await expect(page.getByText('ID 123456', { exact: true })).toBeVisible();
  await expect(page.getByText('Не подключён', { exact: true })).toBeVisible();
});

test('админка показывает отдельную вкладку со всеми пользователями', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Пользователи' }).click();

  await expect(page.getByRole('heading', { name: 'Пользователи' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Поиск пользователя' })).toBeVisible();
});

test('администратор создаёт мероприятие и запускает ZIP-экспорт', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Обзор артефактов' })).toBeVisible();
  await page.getByRole('button', { name: 'Мероприятия' }).click();
  await page.getByRole('button', { name: 'Создать мероприятие' }).click();

  const suffix = Date.now().toString().slice(-7);
  await page.getByLabel('Название').fill(`E2E мероприятие ${suffix}`);
  await expect(page.getByText(`e2e-meropriyatie-${suffix}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Slug создаётся автоматически')).toBeVisible();
  await expect(page.getByText('Короткий код создаётся автоматически')).toBeVisible();
  await expect(page.getByText('Все даты: Новосибирск (UTC+7)')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Начало мероприятия' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Окончание приёма материалов' })).toBeVisible();
  await page.getByLabel('Статус').selectOption('running');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(page.getByText(`E2E мероприятие ${suffix}`)).toBeVisible();
  await page.getByRole('button', { name: 'Экспорт' }).click();
  await page.getByRole('button', { name: 'Полный ZIP' }).click();
  await expect(page.getByText('ZIP').first()).toBeVisible();
});

test('конструктор товара принимает файл, а не ссылку Beget', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Товары' }).click();

  await expect(page.getByRole('heading', { name: 'Конструктор товара' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Изображения товара' })).toBeVisible();
  await expect(page.getByText('Перетащите сюда или выберите JPG, PNG, WebP')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /обложка|url изображения|beget/i })).toHaveCount(
    0,
  );
  await expect(
    page.locator('input[type="file"][accept="image/jpeg,image/png,image/webp"]'),
  ).toHaveCount(1);
});
