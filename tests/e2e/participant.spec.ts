import { expect, test } from '@playwright/test';

test('участник ищет мероприятие и отправляет текст с файлом', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Найдите мероприятие' })).toBeVisible();

  await page.getByPlaceholder('Название, код, организатор').fill('DEMO2026');
  await page.getByRole('button', { name: /Сбор артефактов/ }).click();
  await page.getByRole('button', { name: 'Добавить артефакт' }).click();

  await page.getByLabel('Название').fill('Материалы Playwright');
  await page.getByLabel('Текст или описание').fill('Автоматический пользовательский сценарий');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'playwright-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('CPI artifact e2e'),
  });
  await page.getByRole('button', { name: 'Отправить материалы' }).click();

  await expect(page.getByRole('heading', { name: 'Материалы приняты' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Готово' }).click();
  await page.getByRole('button', { name: /Мои материалы/ }).click();
  await expect(page.getByText('Материалы Playwright')).toBeVisible();
});
