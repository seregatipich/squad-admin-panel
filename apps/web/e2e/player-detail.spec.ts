import { expect, test } from './_fixtures';
import { runSql } from './helpers';

function seedPlayer(steamId: string, name: string) {
  runSql(
    `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized) VALUES (${steamId}, '${name}', '${name.toLowerCase()}') ON CONFLICT (steam_id64) DO NOTHING`,
  );
  runSql(
    `INSERT INTO player_name_history (steam_id64, name, name_normalized) VALUES (${steamId}, '${name}', '${name.toLowerCase()}') ON CONFLICT DO NOTHING`,
  );
}

function teardownPlayer(steamId: string) {
  runSql(`DELETE FROM player_name_history WHERE steam_id64=${steamId}`);
  runSql(`DELETE FROM players WHERE steam_id64=${steamId}`);
}

test.describe('player detail page', () => {
  const probeId = '76561198000000099';
  const probeName = 'pw-player-detail-probe';

  test.beforeAll(() => {
    seedPlayer(probeId, probeName);
  });

  test.afterAll(() => {
    teardownPlayer(probeId);
  });

  test('shows player profile section', async ({ ownerPage }) => {
    await ownerPage.goto(`/players/${probeId}`);
    await expect(ownerPage.locator('h2', { hasText: 'Профиль' })).toBeVisible({ timeout: 10_000 });
    await expect(ownerPage.locator(`text=${probeName}`).first()).toBeVisible();
  });

  test('shows panel-access section for Owner', async ({ ownerPage }) => {
    await ownerPage.goto(`/players/${probeId}`);
    await expect(ownerPage.locator('h2', { hasText: 'Доступ к панели' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
