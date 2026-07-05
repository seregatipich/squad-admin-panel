import { expect, test } from './_fixtures';

test.describe('wave-6 AN-1 (Owner)', () => {
  test('dashboard renders the analytics panel', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    await expect(ownerPage.locator('body')).toContainText(/аналитик|пик|матч|карт|статист/i, {
      timeout: 12_000,
    });
  });
});
