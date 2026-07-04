import { expect, test } from './_fixtures';

test.describe('roles / groups page', () => {
  test('legacy /roles redirects to /settings/groups', async ({ ownerPage }) => {
    await ownerPage.goto('/roles');
    await expect(ownerPage).toHaveURL(/\/settings\/groups$/);
  });

  test('lists system roles as cards', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/groups');
    for (const name of ['Owner', 'Admin', 'Moderator']) {
      await expect(ownerPage.getByRole('heading', { level: 2, name, exact: true })).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test('Owner role is marked as a system role', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/groups');
    await expect(ownerPage.locator('body')).toContainText('Системная роль', { timeout: 10_000 });
  });

  test('Owner role has no delete button', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/groups');
    const ownerCard = ownerPage
      .locator('section')
      .filter({ has: ownerPage.getByRole('heading', { level: 2, name: 'Owner', exact: true }) });
    await expect(ownerCard).toBeVisible({ timeout: 10_000 });
    await expect(ownerCard.getByTitle('Удалить роль')).toHaveCount(0);
  });
});
