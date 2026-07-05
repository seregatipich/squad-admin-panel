import { expect, test } from './_fixtures';

const PRIMETIME_PLAYER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CLAN_ID = 'c8000000-0000-4000-8000-0000000000c1';

test('LEAD-2: leaderboards page renders ranked rows', async ({ ownerPage }) => {
  const res = ownerPage.waitForResponse((r) => r.url().includes('/api/v1/leaderboards') && r.ok());
  await ownerPage.goto('/leaderboards', { waitUntil: 'networkidle' });
  await res;
  await expect(ownerPage.getByText(/Лидерборд|Рейтинг|Онлайн/i).first()).toBeVisible();
  await expect(ownerPage.locator('table tbody tr').first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveC-lead2-leaderboards.png', fullPage: true });
});

test('PRES-5: player card shows primetime section', async ({ ownerPage }) => {
  const res = ownerPage.waitForResponse((r) => r.url().includes('/primetime') && r.ok());
  await ownerPage.goto(`/players/${PRIMETIME_PLAYER}`, { waitUntil: 'networkidle' });
  await res;
  await expect(ownerPage.getByText(/Праймтайм/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveC-pres5-primetime.png', fullPage: true });
});

test('COMBAT-4: combat log page renders events', async ({ ownerPage }) => {
  const res = ownerPage.waitForResponse((r) => r.url().includes('/api/v1/combat-events') && r.ok());
  await ownerPage.goto('/combat-log', { waitUntil: 'networkidle' });
  await res;
  await expect(ownerPage.getByText(/Боевой лог|Убийств|Оружие/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveC-combat4-log.png', fullPage: true });
});

test('AUTO-3: alerts settings page renders rules', async ({ ownerPage }) => {
  const res = ownerPage.waitForResponse((r) => r.url().includes('/api/v1/alert-rules') && r.ok());
  await ownerPage.goto('/settings/alerts', { waitUntil: 'networkidle' });
  await res;
  await expect(ownerPage.getByText(/Оповещени|Правил|Alert/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveC-auto3-alerts.png', fullPage: true });
});

test('CLAN-8: clan card shows match history', async ({ ownerPage }) => {
  await ownerPage.goto(`/clans/${CLAN_ID}`, { waitUntil: 'networkidle' });
  await expect(ownerPage.getByText(/Клан История|матч/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveC-clan8-matches.png', fullPage: true });
});

test('AUTO-3: alert-rules + alerts APIs respond for Owner', async ({ ownerPage }) => {
  const rules = await ownerPage.request.get('/api/v1/alert-rules');
  expect(rules.ok()).toBe(true);
  const feed = await ownerPage.request.get('/api/v1/alerts');
  expect(feed.status()).toBeLessThan(500);
});
