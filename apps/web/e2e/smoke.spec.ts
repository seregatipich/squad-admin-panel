import { expect, test } from '@playwright/test';

test.describe('panel smoke flows (unauthenticated)', () => {
  test('api /api/v1/setup/status responds', async ({ request }) => {
    const resp = await request.get('/api/v1/setup/status');
    expect([200, 410]).toContain(resp.status());
    const body = await resp.json();
    expect(body).toBeTruthy();
  });

  test('api /api/v1/permissions is gated behind role:view', async ({ request }) => {
    const resp = await request.get('/api/v1/permissions');
    expect(resp.status()).toBe(401);
  });

  test('api /api/v1/me without cookie is 401', async ({ request }) => {
    const resp = await request.get('/api/v1/me');
    expect(resp.status()).toBe(401);
  });

  test('login page loads and offers BSS retry after a recoverable error', async ({ page }) => {
    const resp = await page.goto('/login?error=sso_failed');
    expect(resp?.ok()).toBe(true);
    await expect(page.getByRole('link', { name: 'Повторить вход' })).toHaveAttribute(
      'href',
      '/api/v1/auth/bss/login',
    );
  });
});
