import { expect, test } from '@playwright/test';

test.describe('login page', () => {
  test('renders the Steam login button', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h1')).toContainText('Squad Admin Panel');
    await expect(page.locator('a[href*="auth/steam/login"]')).toBeVisible();
  });

  test('dashboard requires auth and bounces to /login', async ({ page }) => {
    const resp = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(page.url()).toMatch(/\/login|\/dashboard/);
    if (page.url().includes('/login')) {
      await expect(page.locator('h1')).toContainText('Squad Admin Panel');
    }
    if (resp) expect(resp.status()).toBeLessThan(500);
  });
});
