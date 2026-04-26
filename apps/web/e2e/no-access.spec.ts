import { expect, test } from './_fixtures';

test.describe('no-access page', () => {
  test('renders heading and steam_id64 from query param', async ({ unauthedPage }) => {
    await unauthedPage.goto('/no-access?steam_id64=76561199999999999');
    await expect(unauthedPage.locator('h1')).toContainText('Доступ запрещён');
    await expect(unauthedPage.locator('text=76561199999999999')).toBeVisible();
  });

  test('renders generic message when steam_id64 is absent', async ({ unauthedPage }) => {
    await unauthedPage.goto('/no-access');
    await expect(unauthedPage.locator('h1')).toContainText('Доступ запрещён');
    await expect(unauthedPage.locator('text=Ваш Steam-аккаунт не имеет роли')).toBeVisible();
  });
});
