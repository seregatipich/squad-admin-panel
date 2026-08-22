import { expect, test } from './_fixtures';

test.describe('dashboard page', () => {
  test('Owner sees every top-bar entry, and its pages once a menu is open', async ({
    ownerPage,
  }) => {
    await ownerPage.goto('/dashboard');
    const bar = ownerPage.getByRole('navigation', { name: 'Основная навигация' });
    for (const entry of ['Серверы', 'Игроки', 'Инструменты', 'Сообщество', 'Аудит', 'Настройки']) {
      await expect(bar.getByRole('button', { name: new RegExp(`^${entry}`) })).toBeVisible();
    }

    // The pages themselves live in dropdowns, which open on click.
    await bar.getByRole('button', { name: /^Аудит/ }).click();
    await expect(bar.getByRole('link', { name: /Журнал действий/ })).toBeVisible();

    await bar.getByRole('button', { name: /^Настройки/ }).click();
    await expect(bar.getByRole('link', { name: /Группы/ })).toBeVisible();

    await bar.getByRole('button', { name: /^Игроки/ }).click();
    await expect(bar.getByRole('link', { name: /Администрация/ })).toBeVisible();
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
