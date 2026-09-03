import { expect, test, type Page, type Route } from '@playwright/test';
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

const productIds = {
  published: '00000000-0000-4000-8000-000000000101',
  draft: '00000000-0000-4000-8000-000000000102',
} as const;

const postIds = {
  eligible: '00000000-0000-4000-8000-000000000201',
  future: '00000000-0000-4000-8000-000000000202',
  event: '00000000-0000-4000-8000-000000000203',
  draft: '00000000-0000-4000-8000-000000000204',
  restricted: '00000000-0000-4000-8000-000000000205',
} as const;

type BroadcastEntityType = 'feed_post' | 'product';

interface BroadcastCall {
  entityType: BroadcastEntityType;
  entityId: string;
  idempotencyKey: string | null;
}

const admin = {
  id: '00000000-0000-4000-8000-000000000001',
  telegramUserId: '700001',
  messengerProvider: 'telegram',
  messengerUserId: '700001',
  telegramUsername: 'admin_e2e',
  fullName: 'Администратор Тестов',
  organization: 'НГУ',
  position: 'Администратор',
  phone: '+70000000000',
  consentAt: '2026-08-28T00:00:00.000Z',
  roles: ['admin'],
  profileComplete: true,
};

const products = [
  {
    id: productIds.published,
    title: 'Опубликованный товар',
    description: null,
    price: '500',
    status: 'published',
    kind: 'physical',
    stockMode: 'unlimited',
    stock: null,
    media: [],
  },
  {
    id: productIds.draft,
    title: 'Черновик товара',
    description: null,
    price: '100',
    status: 'draft',
    kind: 'physical',
    stockMode: 'limited',
    stock: 1,
    media: [],
  },
];

const posts = [
  {
    id: postIds.eligible,
    kind: 'news',
    audience: 'all',
    title: 'Новость для всех',
    summary: 'Готова к ручной рассылке',
    body: 'Текст новости',
    bodyFormat: 'text',
    cardHtml: null,
    cardPackageId: null,
    coverUrl: null,
    ctaLabel: null,
    ctaUrl: null,
    pinned: false,
    status: 'published',
    publishedAt: null,
  },
  {
    id: postIds.future,
    kind: 'news',
    audience: 'all',
    title: 'Будущая новость',
    summary: null,
    body: 'Ещё не наступила',
    bodyFormat: 'text',
    cardHtml: null,
    cardPackageId: null,
    coverUrl: null,
    ctaLabel: null,
    ctaUrl: null,
    pinned: false,
    status: 'published',
    publishedAt: '2099-01-01T00:00:00.000Z',
  },
  {
    id: postIds.event,
    kind: 'event',
    audience: 'all',
    title: 'Событие в ленте',
    summary: null,
    body: 'Не новость',
    bodyFormat: 'text',
    cardHtml: null,
    cardPackageId: null,
    coverUrl: null,
    ctaLabel: null,
    ctaUrl: null,
    pinned: false,
    status: 'published',
    publishedAt: null,
  },
  {
    id: postIds.draft,
    kind: 'news',
    audience: 'all',
    title: 'Черновик новости',
    summary: null,
    body: 'Не опубликована',
    bodyFormat: 'text',
    cardHtml: null,
    cardPackageId: null,
    coverUrl: null,
    ctaLabel: null,
    ctaUrl: null,
    pinned: false,
    status: 'draft',
    publishedAt: null,
  },
  {
    id: postIds.restricted,
    kind: 'news',
    audience: 'participants',
    title: 'Новость только участникам',
    summary: null,
    body: 'Ограниченная аудитория',
    bodyFormat: 'text',
    cardHtml: null,
    cardPackageId: null,
    coverUrl: null,
    ctaLabel: null,
    ctaUrl: null,
    pinned: false,
    status: 'published',
    publishedAt: null,
  },
];

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installAdminApiMock(page: Page): Promise<BroadcastCall[]> {
  const broadcastCalls: BroadcastCall[] = [];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/u, '');

    if (request.method() === 'POST' && path === '/auth/telegram') {
      return json(route, {
        user: admin,
        csrfToken: 'admin-csrf-e2e',
        sessionToken: 'admin-session-e2e',
      });
    }
    if (request.method() === 'GET' && path === '/me') return json(route, admin);
    if (request.method() === 'GET' && path === '/admin/dashboard') {
      return json(route, {
        activeEvents: 0,
        participants: 0,
        submissions: 0,
        artifacts: 0,
        storageBytes: 0,
        failedUploads: 0,
        latestUploads: [],
      });
    }
    if (request.method() === 'GET' && path === '/admin/store/products') {
      return json(route, { items: products });
    }
    if (request.method() === 'GET' && path === '/admin/store/categories') {
      return json(route, { items: [] });
    }
    if (request.method() === 'GET' && path === '/admin/feed') {
      return json(route, { items: posts });
    }
    if (request.method() === 'POST' && path === '/admin/broadcasts') {
      const body = request.postDataJSON() as {
        entityType: BroadcastEntityType;
        entityId: string;
      };
      broadcastCalls.push({
        ...body,
        idempotencyKey: request.headers()['idempotency-key'] ?? null,
      });
      return json(route, {
        broadcastId: `broadcast-${broadcastCalls.length}`,
        type: body.entityType,
        status: 'queued',
        recipientCount: 12,
      });
    }

    return json(
      route,
      { error: { code: 'E2E_UNMOCKED', message: `${request.method()} ${path}` } },
      501,
    );
  });

  return broadcastCalls;
}

function broadcastButtonIn(page: Page, listSelector: string, title: string) {
  return page
    .locator(`${listSelector} article`)
    .filter({ hasText: title })
    .getByRole('button', { name: 'Отправить рассылку' });
}

test('администратор вручную ставит в очередь рассылки товара и новости', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installMessengerMock(page, 'telegram');
  const broadcastCalls = await installAdminApiMock(page);
  await page.goto('/admin');

  await test.step('опубликованный товар доступен для рассылки, а черновик — нет', async () => {
    await page.getByRole('button', { name: 'Товары', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Конструктор товара' })).toBeVisible();

    const publishedButton = broadcastButtonIn(
      page,
      '.wallet-product-admin-list',
      'Опубликованный товар',
    );
    await expect(publishedButton).toHaveCount(1);
    await expect(
      broadcastButtonIn(page, '.wallet-product-admin-list', 'Черновик товара'),
    ).toHaveCount(0);

    await publishedButton.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Отправить «Опубликованный товар»?' }),
    ).toBeVisible();
    await expect(dialog.getByText('Рассылка в Telegram и MAX')).toBeVisible();
    await dialog.getByRole('button', { name: 'Отправить рассылку' }).click();

    await expect(
      page.getByText('Рассылка «Опубликованный товар» поставлена в очередь. Получателей: 12.'),
    ).toBeVisible();
    await expect.poll(() => broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0]).toMatchObject({
      entityType: 'product',
      entityId: productIds.published,
    });
    expect(broadcastCalls[0]?.idempotencyKey).toBeTruthy();
  });

  await test.step('только опубликованная общая новость доступна для рассылки', async () => {
    await page.getByRole('button', { name: 'Публикации', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Новости и обновления' })).toBeVisible();

    const eligibleButton = broadcastButtonIn(page, '.wallet-feed-admin-list', 'Новость для всех');
    await expect(eligibleButton).toHaveCount(1);
    for (const title of [
      'Будущая новость',
      'Событие в ленте',
      'Черновик новости',
      'Новость только участникам',
    ]) {
      await expect(broadcastButtonIn(page, '.wallet-feed-admin-list', title)).toHaveCount(0);
    }

    await eligibleButton.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Отправить «Новость для всех»?' }),
    ).toBeVisible();
    await expect(dialog.getByText('Рассылка в Telegram и MAX')).toBeVisible();
    await dialog.getByRole('button', { name: 'Отправить рассылку' }).click();

    await expect(
      page.getByText('Рассылка «Новость для всех» поставлена в очередь. Получателей: 12.'),
    ).toBeVisible();
    await expect.poll(() => broadcastCalls).toHaveLength(2);
    expect(broadcastCalls.filter((call) => call.entityType === 'product')).toHaveLength(1);
    const feedCalls = broadcastCalls.filter((call) => call.entityType === 'feed_post');
    expect(feedCalls).toHaveLength(1);
    expect(feedCalls[0]).toMatchObject({
      entityType: 'feed_post',
      entityId: postIds.eligible,
    });
    expect(feedCalls[0]?.idempotencyKey).toBeTruthy();
    expect(feedCalls[0]?.idempotencyKey).not.toBe(broadcastCalls[0]?.idempotencyKey);
  });

  expect(pageErrors).toEqual([]);
});
