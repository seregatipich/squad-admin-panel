import { expect, test } from '@playwright/test';

test.describe('panel smoke flows (unauthenticated)', () => {
  test('api /api/v1/setup/check-env responds', async ({ request }) => {
    const resp = await request.get('/api/v1/setup/check-env');
    // Either 200 { ok } or 410 setup_already_complete — both are valid.
    expect([200, 410]).toContain(resp.status());
    const body = await resp.json();
    expect(body).toBeTruthy();
  });

  test('api /api/v1/permissions returns system roles + registry', async ({ request }) => {
    const resp = await request.get('/api/v1/permissions');
    expect(resp.ok()).toBe(true);
    const body = await resp.json();
    expect(body.permissions).toContain('server:view');
    expect(body.roles.map((r: { name: string }) => r.name).sort()).toEqual([
      'Admin',
      'Owner',
      'Senior Admin',
      'Viewer',
    ]);
  });

  test('api /api/v1/me without cookie is 401', async ({ request }) => {
    const resp = await request.get('/api/v1/me');
    expect(resp.status()).toBe(401);
  });

  test('login page loads and serves html', async ({ page }) => {
    const resp = await page.goto('/login');
    expect(resp?.ok()).toBe(true);
    await expect(page.locator('form')).toBeVisible();
  });
});
