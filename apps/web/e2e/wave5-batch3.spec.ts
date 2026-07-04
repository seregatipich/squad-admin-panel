import { expect, test } from './_fixtures';
import { runSql } from './helpers';

test.describe('wave-5 batch 3 (Owner)', () => {
  test('mark-types management page renders (MARK-4)', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/mark-types');
    await expect(ownerPage.locator('body')).toContainText(/метк|тип/i, { timeout: 10_000 });
  });

  test('issues tracker page renders with controls (ISSUE-2)', async ({ ownerPage }) => {
    await ownerPage.goto('/issues');
    await expect(ownerPage.locator('body')).toContainText(/тикет|создать/i, { timeout: 10_000 });
  });

  test('account page shows active sessions (AUTH-5)', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/account');
    await expect(ownerPage.locator('body')).toContainText(/сесси|устройств|выйти/i, {
      timeout: 10_000,
    });
  });

  test('groups editor exposes the clan-management flag (CLAN-2)', async ({ ownerPage }) => {
    await ownerPage.goto('/settings/groups');
    await expect(ownerPage.locator('body')).toContainText(/клан/i, { timeout: 10_000 });
  });

  test('player card exposes the marks control (MARK-2)', async ({ ownerPage }) => {
    const sid = `7656119${Math.floor(5_000_000_000 + Math.random() * 800_000_000)}`;
    runSql(
      `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized) VALUES (${sid}, 'pw-b3-probe', 'pw-b3-probe') ON CONFLICT (steam_id64) DO NOTHING`,
    );
    const pid = runSql(`SELECT id FROM players WHERE steam_id64=${sid} LIMIT 1`);
    runSql(
      `INSERT INTO player_name_history (player_id, name, name_normalized) VALUES ('${pid}', 'pw-b3-probe', 'pw-b3-probe') ON CONFLICT DO NOTHING`,
    );
    try {
      await ownerPage.goto(`/players/${pid}`);
      await expect(ownerPage.locator('body')).toContainText(/метк/i, { timeout: 10_000 });
    } finally {
      runSql(`DELETE FROM player_marks WHERE player_id='${pid}'`);
      runSql(`DELETE FROM player_name_history WHERE player_id='${pid}'`);
      runSql(`DELETE FROM players WHERE steam_id64=${sid}`);
    }
  });
});
