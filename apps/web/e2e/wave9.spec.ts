import { expect, test } from './_fixtures';
import { runSql } from './helpers';

test.describe('wave-9 (Owner)', () => {
  test('/votes renders (VOTE-2)', async ({ ownerPage }) => {
    await ownerPage.goto('/votes');
    await expect(ownerPage.locator('body')).toContainText(/голосован|vote|инициатор|результат/i, {
      timeout: 12_000,
    });
  });
  test('player card has presence section (PRES-4)', async ({ ownerPage }) => {
    const sid = `7656119${Math.floor(2_000_000_000 + Math.random() * 500_000_000)}`;
    runSql(
      `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized) VALUES (${sid}, 'pw-b9', 'pw-b9') ON CONFLICT (steam_id64) DO NOTHING`,
    );
    const pid = runSql(`SELECT id FROM players WHERE steam_id64=${sid} LIMIT 1`);
    runSql(
      `INSERT INTO player_name_history (player_id, name, name_normalized) VALUES ('${pid}', 'pw-b9', 'pw-b9') ON CONFLICT DO NOTHING`,
    );
    try {
      await ownerPage.goto(`/players/${pid}`);
      await expect(ownerPage.locator('body')).toContainText(/онлайн|присутств|сесси|буст/i, {
        timeout: 12_000,
      });
    } finally {
      runSql(`DELETE FROM player_name_history WHERE player_id='${pid}'`);
      runSql(`DELETE FROM players WHERE steam_id64=${sid}`);
    }
  });
});
