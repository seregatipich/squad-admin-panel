import { expect, test } from './_fixtures';

test.describe('roles page', () => {
  test('lists all system roles with color dots', async ({ ownerPage }) => {
    await ownerPage.goto('/roles');
    const table = ownerPage.locator('table');
    for (const name of ['Owner', 'Senior Admin', 'Admin', 'Moderator', 'Viewer']) {
      await expect(table).toContainText(name);
    }
  });

  test('Owner role shows Системная badge', async ({ ownerPage }) => {
    await ownerPage.goto('/roles');
    await expect(ownerPage.locator('table')).toContainText('Системная', { timeout: 10_000 });
  });

  test('Owner role has no delete button', async ({ ownerPage }) => {
    await ownerPage.goto('/roles');
    const ownerRow = ownerPage.locator('tr', { hasText: 'Owner' });
    await expect(ownerRow.locator('button:has-text("Удалить")')).toHaveCount(0);
  });
});
