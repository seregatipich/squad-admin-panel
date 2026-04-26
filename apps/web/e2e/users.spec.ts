import { expect, test } from './_fixtures';

test.describe('users page', () => {
  test('renders table with the seeded owner row', async ({ ownerPage }) => {
    await ownerPage.goto('/users');
    await expect(ownerPage.locator('h1')).toContainText('Пользователи панели');
    await expect(ownerPage.locator('table')).toContainText('Owner');
  });

  test('assign-role modal opens when button is clicked', async ({ ownerPage }) => {
    await ownerPage.goto('/users');
    const btn = ownerPage.getByRole('button', { name: 'Назначить роль игроку' });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    await expect(ownerPage.locator('h2', { hasText: 'Назначить роль' })).toBeVisible();
  });

  test('assign-role modal closes on cancel', async ({ ownerPage }) => {
    await ownerPage.goto('/users');
    await ownerPage.getByRole('button', { name: 'Назначить роль игроку' }).click();
    await expect(ownerPage.locator('h2', { hasText: 'Назначить роль' })).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Отмена' }).click();
    await expect(ownerPage.locator('h2', { hasText: 'Назначить роль' })).toHaveCount(0);
  });
});
