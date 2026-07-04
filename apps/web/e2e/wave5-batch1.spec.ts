import { expect, test } from './_fixtures';

test.describe('wave-5 batch 1 pages (Owner)', () => {
  test('message templates page renders and lists seeded templates', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/message-templates');
    await expect(ownerPage.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 });
    await expect(ownerPage.locator('body')).toContainText(/шаблон/i, { timeout: 10_000 });
  });

  test('banned names page renders', async ({ ownerPage }) => {
    await ownerPage.goto('/banned-names');
    await expect(ownerPage.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 });
    await expect(ownerPage.locator('body')).toContainText(/ник/i, { timeout: 10_000 });
  });

  test('issues page renders', async ({ ownerPage }) => {
    await ownerPage.goto('/issues');
    await expect(ownerPage.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 });
    await expect(ownerPage.locator('body')).toContainText(/тикет/i, { timeout: 10_000 });
  });

  test('sidebar exposes all three new nav entries', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    const nav = ownerPage.locator('nav');
    await expect(nav).toContainText('Забаненные ники');
    await expect(nav).toContainText('Тикеты');
    await expect(nav).toContainText('Шаблоны сообщений');
  });
});
