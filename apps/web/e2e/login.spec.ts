import { expect, test } from './_fixtures';

test.describe('login page', () => {
  test('renders with Steam login button', async ({ unauthedPage }) => {
    await unauthedPage.goto('/login');
    await expect(unauthedPage.locator('h1')).toContainText('Squad Admin Panel');
    await expect(unauthedPage.locator('a[href*="auth/steam/login"]')).toBeVisible();
  });

  test('auth_failed error param renders user-readable message', async ({ unauthedPage }) => {
    await unauthedPage.goto('/login?error=auth_failed');
    await expect(unauthedPage.locator('text=Не удалось проверить вход через Steam')).toBeVisible();
  });

  test('not_authorized error param shows steam-id-blocked message', async ({ unauthedPage }) => {
    await unauthedPage.goto('/login?error=not_authorized&steam_id64=76561199000000001');
    await expect(unauthedPage.locator('text=76561199000000001')).toBeVisible();
  });
});
