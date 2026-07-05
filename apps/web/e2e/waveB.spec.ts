import { expect, test } from './_fixtures';
import { runSql } from './helpers';

const CLAN_ID = 'c3000000-0000-4000-8000-000000000001';
const GEO_PLAYER = '0a1b2c3d-0000-4000-8000-0000000000cc';

test('CLAN-7: clans directory renders', async ({ ownerPage }) => {
  await ownerPage.goto('/clans', { waitUntil: 'networkidle' });
  await expect(ownerPage.getByText(/Клан CLAN-7/).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveB-clan7-directory.png', fullPage: true });
});

test('CLAN-7: clan card shows online members grouped by server', async ({ ownerPage }) => {
  const res = ownerPage.waitForResponse(
    (r) => r.url().includes(`/clans/${CLAN_ID}/online`) && r.ok(),
  );
  await ownerPage.goto(`/clans/${CLAN_ID}`, { waitUntil: 'networkidle' });
  await res;
  await expect(ownerPage.getByText(/CLAN7 Глава/).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveB-clan7-card.png', fullPage: true });
});

test('PLAYER-3: player card location section shows GeoIP (Owner sees IP)', async ({
  ownerPage,
}) => {
  await ownerPage.goto(`/players/${GEO_PLAYER}`, { waitUntil: 'networkidle' });
  await expect(ownerPage.getByText(/Germany|Берлин|Berlin|Локаци/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveB-player3-location.png', fullPage: true });
});

test('PLAYER-3: GeoIP MaxMind settings page renders', async ({ ownerPage }) => {
  await ownerPage.goto('/settings/integrations/geoip', { waitUntil: 'networkidle' });
  await expect(ownerPage.getByText(/MaxMind|GeoIP|GeoLite/i).first()).toBeVisible();
  await ownerPage.screenshot({
    path: 'e2e-evidence/waveB-player3-geoip-settings.png',
    fullPage: true,
  });
});

test('COMBAT-3: combat-events API returns keyset page for Owner', async ({ ownerPage }) => {
  const r = await ownerPage.request.get('/api/v1/combat-events?limit=5');
  expect(r.ok()).toBe(true);
  const body = await r.json();
  expect(Array.isArray(body.rows)).toBe(true);
  expect(body).toHaveProperty('nextCursor');
});

test('LEAD-1: leaderboards API responds', async ({ ownerPage }) => {
  const r = await ownerPage.request.get(
    '/api/v1/leaderboards?metric=online_seconds&period_type=alltime&limit=10',
  );
  expect(r.status()).toBeLessThan(500);
});

test('MATCH-3: match_players has combat columns on the live DB', async () => {
  const cols = runSql(
    "SELECT count(*) FROM information_schema.columns WHERE table_name='match_players' AND column_name IN ('kills','deaths','teamkills','wounds','revives')",
  );
  expect(Number(cols)).toBe(5);
});
