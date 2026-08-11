import { expect, test } from './_fixtures';
import { runSql } from './helpers';

function seedPlayer(steamId: string, name: string, eosId?: string): string {
  runSql(
    `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized, eos_id) VALUES (${steamId}, '${name}', '${name.toLowerCase()}', ${eosId ? `'${eosId}'` : 'NULL'}) ON CONFLICT (steam_id64) DO NOTHING`,
  );
  const playerId = runSql(`SELECT id FROM players WHERE steam_id64=${steamId} LIMIT 1`);
  runSql(
    `INSERT INTO player_name_history (player_id, name, name_normalized) VALUES ('${playerId}', '${name}', '${name.toLowerCase()}') ON CONFLICT DO NOTHING`,
  );
  return playerId;
}

function teardownPlayer(steamId: string) {
  const playerId = runSql(`SELECT id FROM players WHERE steam_id64=${steamId} LIMIT 1`);
  if (playerId) {
    runSql(`DELETE FROM player_name_history WHERE player_id='${playerId}'`);
  }
  runSql(`DELETE FROM players WHERE steam_id64=${steamId}`);
}

test.describe('player detail page', () => {
  const probeSteamId = '76561198000000099';
  const probeName = 'pw-player-detail-probe';
  const probeEosId = '0002pwplayerdetailprobe0000000099';
  let probeUuid = '';

  test.beforeAll(() => {
    probeUuid = seedPlayer(probeSteamId, probeName, probeEosId);
  });

  test.afterAll(() => {
    teardownPlayer(probeSteamId);
  });

  test('shows player profile section', async ({ ownerPage }) => {
    await ownerPage.goto(`/players/${probeUuid}`);
    await expect(ownerPage.locator('h2', { hasText: 'Профиль' })).toBeVisible({ timeout: 10_000 });
    await expect(ownerPage.locator(`text=${probeName}`).first()).toBeVisible();
    await expect(ownerPage.locator('[data-testid="player-avatar"]')).toBeVisible();
  });

  test('shows EOS copy button for a player with an EOS ID', async ({ ownerPage }) => {
    await ownerPage.goto(`/players/${probeUuid}`);
    await expect(ownerPage.locator('h2', { hasText: 'Профиль' })).toBeVisible({ timeout: 10_000 });
    await expect(ownerPage.getByRole('button', { name: 'Скопировать EOS ID' })).toBeVisible();
  });

  test('shows role widget for Owner', async ({ ownerPage }) => {
    await ownerPage.goto(`/players/${probeUuid}`);
    await expect(ownerPage.locator('h2', { hasText: 'Роль' }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows the explained date-only picker in the role editor', async ({ ownerPage }) => {
    await ownerPage.goto(`/players/${probeUuid}`);
    await ownerPage.getByRole('button', { name: 'Выдать роль' }).click();

    const expiryField = ownerPage.getByRole('button', {
      name: 'Открыть календарь срока действия',
    });
    await expect(expiryField).toContainText('ДД/ММ/ГГГГ');
    await expiryField.click();
    await ownerPage.keyboard.press('Escape');
    await expect(ownerPage.getByPlaceholder('Например: VIP по заявке')).toHaveAttribute(
      'aria-describedby',
    );
    await expect(ownerPage.locator('input[type="datetime-local"]')).toHaveCount(0);
  });
});
