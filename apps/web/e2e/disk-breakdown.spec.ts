import { expect, test } from './_fixtures';

test.describe('disk breakdown modal', () => {
  test('clicking the disk card opens the breakdown dialog with content', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');

    const diskCard = ownerPage.locator('[data-testid="disk-card"]');
    await expect(diskCard).toBeVisible({ timeout: 10_000 });
    await diskCard.click();

    const dialog = ownerPage.getByRole('dialog', { name: 'Что занимает панель' });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText(/Всего:/)).toBeVisible();
    await expect(dialog.getByText(/По типу/)).toBeVisible();
  });

  test('refresh button updates the cache-age indicator to zero', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    await ownerPage.locator('[data-testid="disk-card"]').click();

    const dialog = ownerPage.getByRole('dialog', { name: 'Что занимает панель' });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.getByRole('button', { name: 'Обновить' }).click();

    await expect(dialog.getByText(/обновлено 0 сек назад/)).toBeVisible({ timeout: 10_000 });
  });

  test('Escape closes the modal', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    await ownerPage.locator('[data-testid="disk-card"]').click();

    const dialog = ownerPage.getByRole('dialog', { name: 'Что занимает панель' });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await ownerPage.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 4_000 });
  });

  test('clicking the backdrop closes the modal', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    await ownerPage.locator('[data-testid="disk-card"]').click();

    const dialog = ownerPage.getByRole('dialog', { name: 'Что занимает панель' });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await ownerPage.mouse.click(8, 8);

    await expect(dialog).toBeHidden({ timeout: 4_000 });
  });
});
