import { expect, test } from '@playwright/test';

test.describe('login page', () => {
  test('offers a BSS retry after a recoverable SSO error', async ({ page }) => {
    await page.goto('/login?error=sso_failed');
    await expect(page.locator('h1')).toContainText('Squad Admin Panel');
    await expect(page.getByRole('link', { name: 'Повторить вход' })).toHaveAttribute(
      'href',
      '/api/v1/auth/bss/login',
    );
  });

  test('dashboard requires auth and bounces to /login', async ({ page }) => {
    await page.route('**/api/v1/auth/bss/login', (route) =>
      route.fulfill({ status: 302, headers: { location: '/login?error=sso_failed' } }),
    );

    const resp = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(/\/login\?error=sso_failed$/);
    await expect(page.locator('h1')).toContainText('Squad Admin Panel');
    if (resp) expect(resp.status()).toBeLessThan(500);
  });
});
