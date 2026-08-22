import { expect, test } from './_fixtures';
import { runSql } from './helpers';

test.describe('wave-5 batch 2 pages (Owner)', () => {
  test('discord integration settings page renders', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/integrations/discord');
    await expect(ownerPage.locator('body')).toContainText(/discord/i, { timeout: 10_000 });
  });

  test('ban sources page renders', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/ban-sources');
    await expect(ownerPage.locator('body')).toContainText(/источник|бан/i, { timeout: 10_000 });
  });

  test('player card exposes notes section', async ({ ownerPage }) => {
    const sid = `7656119${Math.floor(6_000_000_000 + Math.random() * 900_000_000)}`;
    runSql(
      `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized) VALUES (${sid}, 'pw-b2-probe', 'pw-b2-probe') ON CONFLICT (steam_id64) DO NOTHING`,
    );
    const pid = runSql(`SELECT id FROM players WHERE steam_id64=${sid} LIMIT 1`);
    runSql(
      `INSERT INTO player_name_history (player_id, name, name_normalized) VALUES ('${pid}', 'pw-b2-probe', 'pw-b2-probe') ON CONFLICT DO NOTHING`,
    );
    try {
      await ownerPage.goto(`/players/${pid}`);
      await expect(ownerPage.locator('body')).toContainText(/заметк/i, { timeout: 10_000 });
    } finally {
      runSql(`DELETE FROM player_name_history WHERE player_id='${pid}'`);
      runSql(`DELETE FROM players WHERE steam_id64=${sid}`);
    }
  });

  test('the top bar exposes the new integration + ban-source pages', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    const bar = ownerPage.getByRole('navigation', { name: 'Основная навигация' });
    await bar.getByRole('button', { name: /^Настройки/ }).click();
    await expect(bar.getByRole('link', { name: /Discord/ })).toBeVisible({ timeout: 10_000 });
    await expect(bar.getByRole('link', { name: /Источники банов/ })).toBeVisible();
  });
});
