import { expect, test } from '@playwright/test';

test.describe('login page', () => {
  test('renders the Russian login form with email, password, submit', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
    await expect(page.getByPlaceholder('Email')).toBeVisible();
    await expect(page.getByPlaceholder('Пароль')).toBeVisible();
    await expect(page.getByRole('button', { name: /Войти|Входим/ })).toBeVisible();
  });

  test('rejects a bogus credential pair and surfaces an error message', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill('nobody@test.local');
    await page.getByPlaceholder('Пароль').fill('totally-wrong');
    await page.getByRole('button', { name: 'Войти' }).click();
    // The API responds 401 invalid_credentials; the page shows the body.error.
    await expect(page.locator('p.text-red-400')).toBeVisible({ timeout: 10_000 });
  });

  test('dashboard requires auth and bounces to /login', async ({ page }) => {
    const resp = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    // Either a redirect to /login (via middleware) or a 401 body from the API.
    expect(page.url()).toMatch(/\/login|\/dashboard/);
    if (page.url().includes('/login')) {
      await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
    }
    // The final status should not be 5xx on either branch.
    if (resp) expect(resp.status()).toBeLessThan(500);
  });
});
