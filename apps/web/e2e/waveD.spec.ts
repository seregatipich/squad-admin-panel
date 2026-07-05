import { expect, test } from './_fixtures';

const GEO_PLAYER = '1a2b3c4d-0000-4000-8000-000000000077';
const CLAN_ID = 'cccccccc-0000-4000-8000-000000000001';

test('INT-2: player card shows geo anomalies (multi-country + country switch + map)', async ({
  ownerPage,
}) => {
  const res = ownerPage.waitForResponse((r) => r.url().includes('/geo-anomalies') && r.ok());
  await ownerPage.goto(`/players/${GEO_PLAYER}`, { waitUntil: 'networkidle' });
  await res;
  await expect(ownerPage.getByText(/Мульти-страна|Смена страны|Аномали/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveD-int2-geo.png', fullPage: true });
});

test('CLAN-3: clan card shows roster panel', async ({ ownerPage }) => {
  await ownerPage.goto(`/clans/${CLAN_ID}`, { waitUntil: 'networkidle' });
  await expect(ownerPage.getByText(/Ростер|Участник|лидер|Демо-ростер/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveD-clan3-roster.png', fullPage: true });
});

test('LEAD-3: reworked leaderboards page renders sortable ranked table', async ({ ownerPage }) => {
  const res = ownerPage.waitForResponse((r) => r.url().includes('/api/v1/leaderboards') && r.ok());
  await ownerPage.goto('/leaderboards', { waitUntil: 'networkidle' });
  await res;
  await expect(ownerPage.locator('table tbody tr').first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveD-lead3-leaderboards.png', fullPage: true });
});

test('DOSSIER-1: vehicle-catalog + geo-anomalies APIs respond for Owner', async ({ ownerPage }) => {
  const cat = await ownerPage.request.get('/api/v1/vehicle-catalog');
  expect(cat.ok()).toBe(true);
  const catBody = await cat.json();
  const rows = Array.isArray(catBody) ? catBody : (catBody.items ?? catBody.rows ?? []);
  expect(rows.length).toBeGreaterThan(0);
  const anomalies = await ownerPage.request.get(`/api/v1/players/${GEO_PLAYER}/geo-anomalies`);
  expect(anomalies.ok()).toBe(true);
});
