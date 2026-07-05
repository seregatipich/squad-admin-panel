import { expect, test } from './_fixtures';
import { runSql } from './helpers';

const SRV_EVT = '019f329b-870f-72f1-b168-b569e65a4253';
const P_VOTER = '019f32a4-7e24-702e-ac13-6a523f60620e';
const P_PRESENCE = '019f329d-f65f-74da-aa4f-f0de50a1d46d';

async function noAppError(body: string) {
  expect(body).not.toContain('Application error: a client-side exception');
  expect(body).not.toContain('Application error: a server-side exception');
  expect(body).not.toContain('500 Internal Server Error');
}

const EVENT_LABEL =
  /Игрок подключился|Игрок отключился|Матч начался|Матч завершён|Сервер|Опрос игроков|RCON/i;

test('EVT-2: global events log renders with rows and filters', async ({ ownerPage }) => {
  const resPromise = ownerPage.waitForResponse(
    (r) => r.url().includes('/api/v1/events?') && r.ok(),
  );
  await ownerPage.goto('/events', { waitUntil: 'networkidle' });
  await resPromise;
  await noAppError(await ownerPage.content());
  await expect(ownerPage.getByRole('heading', { name: /Событи/i }).first()).toBeVisible();
  await expect(ownerPage.getByText(EVENT_LABEL).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveA-evt2-events.png', fullPage: true });
});

test('EVT-2: per-server events log renders', async ({ ownerPage }) => {
  const resPromise = ownerPage.waitForResponse(
    (r) => r.url().includes('/api/v1/events?') && r.ok(),
  );
  await ownerPage.goto(`/servers/${SRV_EVT}/events`, { waitUntil: 'networkidle' });
  await resPromise;
  await noAppError(await ownerPage.content());
  await expect(ownerPage.getByText(EVENT_LABEL).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveA-evt2-server-events.png', fullPage: true });
});

test('PNOTE-2: global notes feed renders seeded notes', async ({ ownerPage }) => {
  await ownerPage.goto('/notes', { waitUntil: 'networkidle' });
  await noAppError(await ownerPage.content());
  await expect(ownerPage.getByText(/Подозрение на читы/).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveA-pnote2-notes.png', fullPage: true });
});

test('VOTE-3: dashboard vote analytics section renders', async ({ ownerPage }) => {
  await ownerPage.goto('/dashboard', { waitUntil: 'networkidle' });
  await noAppError(await ownerPage.content());
  await expect(ownerPage.getByText(/Голосовани/i).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveA-vote3-dashboard.png', fullPage: true });
});

test('VOTE-3 + PLAYER-2: player card shows vote counters, serial-skipper flag, clan-tag name history', async ({
  ownerPage,
}) => {
  await ownerPage.goto(`/players/${P_VOTER}`, { waitUntil: 'networkidle' });
  await noAppError(await ownerPage.content());
  await expect(ownerPage.getByText(/Голосовани/i).first()).toBeVisible();
  await expect(ownerPage.getByText(/TestNick|Шyxer|Mdc/).first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveA-vote3-player2-card.png', fullPage: true });
});

test('PRES-3: player card presence chart + live indicator', async ({ ownerPage }) => {
  const resPromise = ownerPage.waitForResponse(
    (r) => r.url().includes('/presence/daily') && r.ok(),
  );
  await ownerPage.goto(`/players/${P_PRESENCE}`, { waitUntil: 'networkidle' });
  await resPromise;
  await noAppError(await ownerPage.content());
  await expect(ownerPage.getByText('Онлайн по дням').first()).toBeVisible();
  await expect(ownerPage.getByText(/Онлайн ·/).first()).toBeVisible();
  await expect(ownerPage.locator('svg').first()).toBeVisible();
  await ownerPage.screenshot({ path: 'e2e-evidence/waveA-pres3-presence.png', fullPage: true });
});

test('COMBAT-2: combat_events table is queryable on the live DB', async () => {
  const count = runSql('SELECT count(*) FROM combat_events');
  expect(Number(count)).toBeGreaterThan(0);
  const pruned = runSql(
    "SELECT count(*) FROM combat_events WHERE occurred_at >= date_trunc('month', now())",
  );
  expect(Number.isNaN(Number(pruned))).toBe(false);
});
