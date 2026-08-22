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
import { redisCmd, runSql, seedOwner, teardownOwner } from './helpers';

test.describe.configure({ mode: 'serial' });

function pickRunningServerId(): string {
  return runSql("SELECT id FROM servers WHERE status='running' LIMIT 1");
}

function insertSyntheticServer(suffix: string, status: string): string {
  const id = runSql('SELECT gen_random_uuid()');
  runSql(
    `INSERT INTO servers (id, display_name, slug, status) VALUES ('${id}', 'logs-resilience ${suffix}', 'logs-resilience-${suffix}', '${status}')`,
  );
  return id;
}

function deleteSyntheticServer(id: string) {
  runSql(`DELETE FROM servers WHERE id='${id}'`);
}

test.describe('docker-logs WS resilience', () => {
  let ownerUid = '';
  let ownerToken = '';

  test.beforeAll(async () => {
    const seed = await seedOwner();
    ownerUid = seed.uid;
    ownerToken = seed.token;
  });

  test.afterAll(async () => {
    if (ownerUid) await teardownOwner(ownerUid);
  });

  async function attachOwnerCookie(page: import('@playwright/test').Page) {
    const baseURL = test.info().project.use.baseURL ?? 'https://squad-panel.lan';
    await page.context().addCookies([
      {
        name: '__Host-sid',
        value: ownerToken,
        url: baseURL,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  }

  test('Test 1: live pill + log lines arrive on a running server', async ({ page }) => {
    const runningId = pickRunningServerId();
    if (!runningId) {
      test.skip(true, 'no running server — bring one up via the install flow first');
      return;
    }
    await attachOwnerCookie(page);
    await page.goto(`/servers/${runningId}`);

    const livePill = page.locator('span:has-text("live")').first();
    await expect(livePill).toBeVisible({ timeout: 8_000 });

    // Область журнала объявлена как role="log" и названа своим заголовком:
    // прежний путь через родителя и класс `font-mono` ломался от любой правки
    // вёрстки.
    const logViewport = page.getByRole('log', { name: /Лог контейнера/ });
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

  test('Test 4: pre-install server shows "ещё не создан", not "Подключение…"', async ({ page }) => {
    const installingId = insertSyntheticServer('preinstall', 'installing');
    try {
      await attachOwnerCookie(page);
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
  }) => {
    const fakeId = insertSyntheticServer('no-container', 'running');
    try {
      await attachOwnerCookie(page);
      await page.goto(`/servers/${fakeId}`);

      const banner = page.locator('[data-testid="logconsole-error-banner"]');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Соединение разорвано');

      const retryBtn = banner.locator('button:has-text("Переподключиться")');
      await expect(retryBtn).toBeVisible();

      await page.waitForTimeout(6_000);
      await expect(banner).toBeVisible();
    } finally {
      redisCmd(['DEL', `rcon:status:${fakeId}`]);
      deleteSyntheticServer(fakeId);
    }
  });
});
