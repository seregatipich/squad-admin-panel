import { expect, test } from './_fixtures';

test.describe('dashboard page', () => {
  test('Owner sees full sidebar nav', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    const nav = ownerPage.locator('nav');
    for (const item of ['Серверы', 'Игроки', 'Журнал действий', 'Роли', 'Пользователи']) {
      await expect(nav).toContainText(item);
    }
  });

  test('dashboard heading is visible', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    await expect(ownerPage.locator('h1')).toContainText('Дашборд');
  });

  test('unauthed request redirects to /login', async ({ unauthedPage }) => {
    await unauthedPage.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(unauthedPage).toHaveURL(/\/login/);
  });
});
