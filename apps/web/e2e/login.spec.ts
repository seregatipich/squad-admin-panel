import { expect, test } from './_fixtures';

test.describe('login page', () => {
  test('renders a BSS retry without a direct Steam route', async ({ unauthedPage }) => {
    await unauthedPage.goto('/login?error=sso_failed');
    await expect(unauthedPage.locator('h1')).toContainText('Squad Admin Panel');
    await expect(unauthedPage.getByRole('link', { name: 'Повторить вход' })).toHaveAttribute(
      'href',
      '/api/v1/auth/bss/login',
    );
    await expect(unauthedPage.locator('a[href*="auth/steam/login"]')).toHaveCount(0);
  });

  test('sso_failed error param renders user-readable message', async ({ unauthedPage }) => {
    await unauthedPage.goto('/login?error=sso_failed');
    await expect(unauthedPage.locator('text=Не удалось войти через bss.games')).toBeVisible();
  });

  test('not_authorized error param shows steam-id-blocked message', async ({ unauthedPage }) => {
    await unauthedPage.goto('/login?error=not_authorized&steam_id64=76561199000000001');
    await expect(unauthedPage.locator('text=76561199000000001')).toBeVisible();
  });
});
