import { expect, test } from './_fixtures';
import { runSql } from './helpers';

test.describe('wave-8 (Owner)', () => {
  test('/settings/chat-flags renders (CHATLOG-5)', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/chat-flags');
    await expect(ownerPage.locator('body')).toContainText(/флаг|правил|чат|профан/i, {
      timeout: 12_000,
    });
  });
  test('player card has recent-matches + bonus sections (MATCH-7, ECON-4)', async ({
    ownerPage,
  }) => {
    const sid = `7656119${Math.floor(3_000_000_000 + Math.random() * 600_000_000)}`;
    runSql(
      `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized) VALUES (${sid}, 'pw-b8', 'pw-b8') ON CONFLICT (steam_id64) DO NOTHING`,
    );
    const pid = runSql(`SELECT id FROM players WHERE steam_id64=${sid} LIMIT 1`);
    runSql(
      `INSERT INTO player_name_history (player_id, name, name_normalized) VALUES ('${pid}', 'pw-b8', 'pw-b8') ON CONFLICT DO NOTHING`,
    );
    try {
      await ownerPage.goto(`/players/${pid}`);
      await expect(ownerPage.locator('body')).toContainText(/матч/i, { timeout: 12_000 });
      await expect(ownerPage.locator('body')).toContainText(/бонус/i, { timeout: 12_000 });
    } finally {
      runSql(`DELETE FROM player_name_history WHERE player_id='${pid}'`);
      runSql(`DELETE FROM players WHERE steam_id64=${sid}`);
    }
  });
});
