import { expect, test } from './_fixtures';
import { runSql } from './helpers';

test.describe('wave-7 pages (Owner)', () => {
  test('/matches renders (MATCH-5)', async ({ ownerPage }) => {
    await ownerPage.goto('/matches');
    await expect(ownerPage.locator('body')).toContainText(/матч|layer|сервер|фильтр/i, {
      timeout: 12_000,
    });
  });
  test('/chat archive renders (CHATLOG-3)', async ({ ownerPage }) => {
    await ownerPage.goto('/chat');
    await expect(ownerPage.locator('body')).toContainText(/чат|сообщ|фильтр|скоуп/i, {
      timeout: 12_000,
    });
  });
  test('/settings/economy renders (ECON-3)', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/economy');
    await expect(ownerPage.locator('body')).toContainText(/эконом|бонус|коэффициент/i, {
      timeout: 12_000,
    });
  });
  test('player card has chat tab (CHATLOG-4)', async ({ ownerPage }) => {
    const sid = `7656119${Math.floor(4_000_000_000 + Math.random() * 700_000_000)}`;
    runSql(
      `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized) VALUES (${sid}, 'pw-b7', 'pw-b7') ON CONFLICT (steam_id64) DO NOTHING`,
    );
    const pid = runSql(`SELECT id FROM players WHERE steam_id64=${sid} LIMIT 1`);
    runSql(
      `INSERT INTO player_name_history (player_id, name, name_normalized) VALUES ('${pid}', 'pw-b7', 'pw-b7') ON CONFLICT DO NOTHING`,
    );
    try {
      await ownerPage.goto(`/players/${pid}`);
      await expect(ownerPage.locator('body')).toContainText(/чат/i, { timeout: 12_000 });
    } finally {
      runSql(`DELETE FROM player_name_history WHERE player_id='${pid}'`);
      runSql(`DELETE FROM players WHERE steam_id64=${sid}`);
    }
  });
});
