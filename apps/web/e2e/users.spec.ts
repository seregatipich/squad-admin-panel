import { expect, test } from './_fixtures';

test.describe('users page', () => {
  test('renders table with the seeded owner row', async ({ ownerPage }) => {
    await ownerPage.goto('/users');
    await expect(ownerPage.locator('h1')).toContainText('Пользователи панели');
    await expect(ownerPage.locator('table')).toContainText('Owner');
  });

  test('assign-role modal opens when button is clicked', async ({ ownerPage }) => {
    await ownerPage.goto('/users');
    const btn = ownerPage.getByRole('button', { name: 'Назначить роль игроку' });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    await expect(ownerPage.locator('h2', { hasText: 'Назначить роль' })).toBeVisible();
    const expiryField = ownerPage.getByRole('button', {
      name: 'Открыть календарь срока действия',
    });
    await expect(expiryField).toContainText('ДД/ММ/ГГГГ');
    await expiryField.click();
    await ownerPage.keyboard.press('Escape');
    await ownerPage.getByTestId('role-expiry-native-date').evaluate((node) => {
      const input = node as HTMLInputElement;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, '2099-12-31');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(ownerPage.getByRole('button', { name: /Выбрано 31\/12\/2099/ })).toContainText(
      '31/12/2099',
    );
    await expect(ownerPage.getByPlaceholder('Например: VIP по заявке')).toHaveAttribute(
      'aria-describedby',
    );
    await expect(ownerPage.locator('input[type="datetime-local"]')).toHaveCount(0);
  });

  test('assign-role modal closes on cancel', async ({ ownerPage }) => {
    await ownerPage.goto('/users');
    await ownerPage.getByRole('button', { name: 'Назначить роль игроку' }).click();
    await expect(ownerPage.locator('h2', { hasText: 'Назначить роль' })).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Отмена' }).click();
    await expect(ownerPage.locator('h2', { hasText: 'Назначить роль' })).toHaveCount(0);
  });
});
