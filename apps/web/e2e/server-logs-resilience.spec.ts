/**
 * The docker-logs WebSocket on /servers/[id] used to silently bail after 3
 * reconnects, leaving users staring at "Подключение к логу контейнера…"
 * indefinitely. This spec pins:
 *   - logs arrive within 12 s for a running server,
 *   - the page never enters a "gave up" state — there's always either a
 *     live pill or a visible error banner explaining what happened,
 *   - servers without a container show the explicit "ещё не создан" copy,
 *     not the generic "Подключение…" placeholder.
 */
import { expect, test } from '@playwright/test';
import {
  loginAndAttachCookie,
  redisCmd,
  runSql,
  seedOwner,
  teardownOwner,
  uniqueEmail,
} from './helpers';

test.describe.configure({ mode: 'serial' });

function pickRunningServerId(): string {
  return runSql("SELECT id FROM servers WHERE status='running' LIMIT 1");
}

function getOrgId(): string {
  return runSql('SELECT id FROM organizations LIMIT 1');
}

function insertSyntheticServer(suffix: string, status: string): string {
  const orgId = getOrgId();
  const id = runSql('SELECT gen_random_uuid()');
  runSql(
    `INSERT INTO servers (id, org_id, display_name, slug, status) VALUES ('${id}', '${orgId}', 'logs-resilience ${suffix}', 'logs-resilience-${suffix}', '${status}')`,
  );
  return id;
}

function deleteSyntheticServer(id: string) {
  runSql(`DELETE FROM servers WHERE id='${id}'`);
}

test.describe('docker-logs WS resilience', () => {
  let ownerEmail = '';
  let ownerUid = '';

  test.beforeAll(async () => {
    ownerEmail = uniqueEmail('lr-logs');
    ownerUid = await seedOwner(ownerEmail);
  });

  test.afterAll(async () => {
    if (ownerUid) await teardownOwner(ownerUid);
  });

  test('Test 1: live pill + log lines arrive on a running server', async ({
    page,
    context,
    request,
  }) => {
    const runningId = pickRunningServerId();
    if (!runningId) {
      test.skip(true, 'no running server — bring one up via the install flow first');
      return;
    }
    await loginAndAttachCookie(page, context, request, ownerEmail);
    await page.goto(`/servers/${runningId}`);

    const livePill = page.locator('span:has-text("live")').first();
    await expect(livePill).toBeVisible({ timeout: 8_000 });

    const logViewport = page
      .locator('div', { hasText: 'Лог контейнера' })
      .locator('..')
      .locator('div.font-mono')
      .first();
    await expect(logViewport).toBeVisible({ timeout: 8_000 });

    await expect
      .poll(
        async () => {
          const text = (await logViewport.textContent()) ?? '';
          const trimmed = text.trim();
          if (trimmed.startsWith('Подключение к логу') || trimmed.startsWith('Сервер остановлен'))
            return 0;
          if (trimmed.length === 0 || trimmed === 'Нет записей') return 0;
          return trimmed.split('\n').filter((l) => l.trim().length > 0).length;
        },
        {
          message: 'no log lines arrived within 12s on a running server',
          timeout: 12_000,
          intervals: [500, 1000],
        },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('Test 4: pre-install server shows "ещё не создан", not "Подключение…"', async ({
    page,
    context,
    request,
  }) => {
    const installingId = insertSyntheticServer('preinstall', 'installing');
    try {
      await loginAndAttachCookie(page, context, request, ownerEmail);
      await page.goto(`/servers/${installingId}`);

      await expect(page.locator('text=ещё не создан').first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('text=Подключение к логу контейнера…')).toHaveCount(0);
    } finally {
      redisCmd(['DEL', `rcon:status:${installingId}`]);
      deleteSyntheticServer(installingId);
    }
  });

  test('Test 3: never enters a permanent "failed" state — error banner with retry is always shown', async ({
    page,
    context,
    request,
  }) => {
    // Synthetic stopped server flipped to "running" so the WS endpoint accepts
    // it and tries `docker logs squad-{uuid}` against a container that does
    // not exist. The bridge errors back, ws closes, the frontend MUST keep
    // retrying with a visible error banner — never silently give up.
    const fakeId = insertSyntheticServer('no-container', 'running');
    try {
      await loginAndAttachCookie(page, context, request, ownerEmail);
      await page.goto(`/servers/${fakeId}`);

      const banner = page.locator('[data-testid="logconsole-error-banner"]');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Соединение разорвано');

      const retryBtn = banner.locator('button:has-text("Переподключиться")');
      await expect(retryBtn).toBeVisible();

      // Banner must persist on subsequent retry cycles — the previous bug
      // hid the offline pill once `reconnects >= 3` and showed nothing.
      await page.waitForTimeout(6_000);
      await expect(banner).toBeVisible();
    } finally {
      redisCmd(['DEL', `rcon:status:${fakeId}`]);
      deleteSyntheticServer(fakeId);
    }
  });
});
