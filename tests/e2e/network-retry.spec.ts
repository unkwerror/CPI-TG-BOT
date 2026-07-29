import { expect, test } from '@playwright/test';

test('обрыв сети повторяет PUT без создания второго артефакта', async ({ page }) => {
  let uploadAttempts = 0;
  await page.route(/\/artifacts-quarantine\//, async (route) => {
    if (route.request().method() === 'PUT' && uploadAttempts++ === 0) {
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });

  await page.goto('/?event=DEMO2026');
  await expect(page.getByRole('heading', { name: /Сбор артефактов/ })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить артефакт' }).click();
  await page.getByLabel('Название').fill('Проверка повтора сети');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'network-retry.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('retry-safe'),
  });
  await page.getByRole('button', { name: 'Отправить материалы' }).click();

  await expect(page.getByRole('heading', { name: 'Материалы приняты' })).toBeVisible({
    timeout: 30_000,
  });
  expect(uploadAttempts).toBeGreaterThanOrEqual(2);
});
