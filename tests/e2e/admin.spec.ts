import { expect, test } from '@playwright/test';

test('администратор создаёт мероприятие и запускает ZIP-экспорт', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await page.getByRole('button', { name: 'Мероприятия' }).click();
  await page.getByRole('button', { name: 'Создать мероприятие' }).click();

  const suffix = Date.now().toString().slice(-7);
  await page.getByLabel('Название').fill(`E2E мероприятие ${suffix}`);
  await page.getByLabel('Slug').fill(`e2e-${suffix}`);
  await page.getByLabel('Короткий код').fill(`E2E${suffix}`);
  await page.getByLabel('Статус').selectOption('running');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(page.getByText(`E2E мероприятие ${suffix}`)).toBeVisible();
  await page.getByRole('button', { name: 'Экспорт' }).click();
  await page.getByRole('button', { name: 'Полный ZIP' }).click();
  await expect(page.getByText('ZIP').first()).toBeVisible();
});
