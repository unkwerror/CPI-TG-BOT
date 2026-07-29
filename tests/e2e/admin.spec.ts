import { expect, test } from '@playwright/test';

test('администратор создаёт мероприятие и запускает ZIP-экспорт', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
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
