import { expect, test } from './_fixtures';

test.describe('no-access page', () => {
  test('renders the no-role message and steam_id64 for reason=no_role', async ({
    unauthedPage,
  }) => {
    await unauthedPage.goto('/no-access?steam_id64=76561199999999999&reason=no_role');
    await expect(unauthedPage.locator('h1')).toContainText('Доступ запрещён');
    await expect(unauthedPage.locator('text=У вас нет доступа к панели')).toBeVisible();
    await expect(unauthedPage.locator('text=76561199999999999')).toBeVisible();
  });

  test('renders the role-without-access message for reason=role_no_access', async ({
    unauthedPage,
  }) => {
    await unauthedPage.goto('/no-access?steam_id64=76561199999999999&reason=role_no_access');
    await expect(unauthedPage.locator('h1')).toContainText('Доступ запрещён');
    await expect(unauthedPage.locator('text=Ваша роль не имеет доступа к панели')).toBeVisible();
  });

  test('falls back to the no-role message when reason is absent', async ({ unauthedPage }) => {
    await unauthedPage.goto('/no-access');
    await expect(unauthedPage.locator('h1')).toContainText('Доступ запрещён');
    await expect(unauthedPage.locator('text=У вас нет доступа к панели')).toBeVisible();
  });
});
