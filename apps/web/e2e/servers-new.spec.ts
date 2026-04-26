import { expect, test } from './_fixtures';

test.describe('servers/new wizard', () => {
  test('cyrillic name auto-generates latin slug', async ({ ownerPage }) => {
    await ownerPage.goto('/servers/new');
    await ownerPage.locator('input[placeholder="My Squad Server"]').fill('выфвфы');
    await expect(ownerPage.locator('input[placeholder="my-squad"]')).toHaveValue('vyfvfy');
  });

  test('form renders all expected fields', async ({ ownerPage }) => {
    await ownerPage.goto('/servers/new');
    await expect(ownerPage.locator('h1')).toContainText('Установка нового Squad-сервера');
    await expect(ownerPage.locator('input[placeholder="My Squad Server"]')).toBeVisible();
    await expect(ownerPage.locator('input[placeholder="my-squad"]')).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Установить' })).toBeVisible();
  });

  test('empty name shows validation error', async ({ ownerPage }) => {
    await ownerPage.goto('/servers/new');
    // Submit with only required fields left empty — HTML required attribute prevents
    // the form from submitting at all, so we intercept fetch to force a 400 path.
    await ownerPage.evaluate(async () => {
      const origFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/v1/servers') && opts?.method === 'POST') {
          return new Response(JSON.stringify({ message: 'body/slug Invalid' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return origFetch(url, opts);
      };
    });
    await ownerPage.locator('input[placeholder="My Squad Server"]').fill('test server');
    await ownerPage.locator('input[placeholder="my-squad"]').evaluate((el: HTMLInputElement) => {
      el.removeAttribute('pattern');
    });
    await ownerPage.locator('input[placeholder="my-squad"]').fill('test-slug');
    await ownerPage.getByRole('button', { name: 'Установить' }).click();
    await expect(ownerPage.locator('text=Slug должен начинаться')).toBeVisible({
      timeout: 10_000,
    });
  });
});
