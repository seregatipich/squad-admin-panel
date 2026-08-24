/**
 * End-to-end proof that EVERY polling surface in the panel reflects backend
 * changes within one polling window without a manual page reload.
 *
 * The suite seeds ONE Owner in beforeAll and reuses the cookie across every
 * test.
 */
import { expect, type Page, test } from '@playwright/test';
import { redisCmd, runSql, seedOwner, teardownOwner } from './helpers';

test.describe.configure({ mode: 'serial' });

let ownerUid = '';
let ownerCookie = '';

async function attachOwnerCookie(page: Page) {
  const baseURL = test.info().project.use.baseURL ?? 'https://squad-panel.lan';
  await page.context().addCookies([
    {
      name: '__Host-sid',
      value: ownerCookie,
      url: baseURL,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

async function expectIndicatorTicks(page: Page, atMostMs = 12_000) {
  const indicator = page.locator('text=/обновлено \\d+с назад/').first();
  await expect(indicator).toBeVisible({ timeout: atMostMs });
  let sawReset = false;
  const deadline = Date.now() + atMostMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const t = (await indicator.textContent())?.match(/(\d+)с/)?.[1];
    if (t && Number(t) <= 1) {
      sawReset = true;
      break;
    }
  }
  expect(sawReset, 'LiveIndicator never reset to ≤1s — polling appears broken').toBe(true);
}

function pickServerId(): string {
  return runSql('SELECT id FROM servers LIMIT 1');
}

function insertSyntheticServer(suffix: string): string {
  const id = runSql('SELECT gen_random_uuid()');
  runSql(
    `INSERT INTO servers (id, display_name, slug, status) VALUES ('${id}', 'live-refresh ${suffix}', 'live-refresh-${suffix}', 'stopped')`,
  );
  return id;
}

function deleteSyntheticServer(id: string) {
  runSql(`DELETE FROM servers WHERE id='${id}'`);
}

test.describe('live refresh — no F5 needed', () => {
  test.beforeAll(async () => {
    const seed = await seedOwner();
    ownerUid = seed.uid;
    ownerCookie = seed.token;
  });

  test.afterAll(async () => {
    if (ownerUid) await teardownOwner(ownerUid);
  });

  test('a) dashboard reflects new server within one poll window', async ({ page }) => {
    let createdId: string | null = null;
    try {
      await attachOwnerCookie(page);
      await page.goto('/dashboard');

      // Плитка показателя рендерит ярлык и значение соседними абзацами.
      // Прежний путь по DOM («text=Серверы» → родитель → второй div) ловил
      // сначала кнопку раздела «Серверы» в верхней панели, а она стоит в
      // документе раньше карточки.
      const kpi = page
        .locator('p', { hasText: /^Серверы$/ })
        .locator('xpath=following-sibling::p[1]');
      await expect(kpi).toBeVisible({ timeout: 10_000 });
      const before = Number((await kpi.textContent())?.trim() ?? '0');

      createdId = insertSyntheticServer('dash-a');

      await expect
        .poll(async () => Number((await kpi.textContent())?.trim() ?? '0'), {
          message: 'dashboard server count never grew',
          timeout: 8_000,
          intervals: [500, 750, 1000],
        })
        .toBe(before + 1);

      deleteSyntheticServer(createdId);
      createdId = null;

      await expect
        .poll(async () => Number((await kpi.textContent())?.trim() ?? '0'), {
          message: 'dashboard server count never decremented',
          timeout: 8_000,
          intervals: [500, 750, 1000],
        })
        .toBe(before);
    } finally {
      if (createdId) deleteSyntheticServer(createdId);
    }
  });

  test('b) servers list reflects status flips within one poll window', async ({ page }) => {
    const createdId = insertSyntheticServer('list-b');
    try {
      await attachOwnerCookie(page);
      await page.goto('/servers');

      const row = page.locator('tr', { has: page.locator(`a[href="/servers/${createdId}"]`) });
      await expect(row).toBeVisible({ timeout: 10_000 });

      // Состояние читается подписью, а не цветом точки: цвет — деталь
      // оформления, подпись — то, что видит и слышит оператор.
      runSql(`UPDATE servers SET status='running' WHERE id='${createdId}'`);
      await expect(row.getByText('работает')).toBeVisible({ timeout: 8_000 });

      runSql(`UPDATE servers SET status='stopped' WHERE id='${createdId}'`);
      await expect(row.getByText('остановлен')).toBeVisible({ timeout: 8_000 });
    } finally {
      deleteSyntheticServer(createdId);
    }
  });

  test('c) server detail reflects RCON flips via redis within one poll window', async ({
    page,
  }) => {
    const targetId = insertSyntheticServer('rcon-c');
    runSql(
      `INSERT INTO server_settings (server_id, install_path, game_port, query_port, beacon_port, rcon_port) VALUES ('${targetId}', '/tmp/${targetId}', 7787, 27166, 15001, 21115)`,
    );
    try {
      await attachOwnerCookie(page);
      await page.goto(`/servers/${targetId}`);

      await expect(page.locator('text=сервер не запущен').first()).toBeVisible({
        timeout: 10_000,
      });

      const payload = JSON.stringify({
        state: 'connected',
        ts: new Date().toISOString(),
        player_count: 7,
        last_poll_at: new Date().toISOString(),
      });
      redisCmd(['SET', `rcon:status:${targetId}`, payload, 'EX', '120']);

      await expect(page.locator('text=connected').first()).toBeVisible({ timeout: 8_000 });

      redisCmd(['DEL', `rcon:status:${targetId}`]);
      await expect(page.locator('text=сервер не запущен').first()).toBeVisible({ timeout: 8_000 });
    } finally {
      redisCmd(['DEL', `rcon:status:${targetId}`]);
      runSql(`DELETE FROM server_settings WHERE server_id='${targetId}'`);
      deleteSyntheticServer(targetId);
    }
  });

  test('d) server events page picks up a new redis envelope within one poll window', async ({
    page,
  }) => {
    const targetId = insertSyntheticServer('evt-d');
    try {
      await attachOwnerCookie(page);
      await page.goto(`/servers/${targetId}/events`);

      const allBtn = page.locator('button:has-text("all (")').first();
      await expect(allBtn).toBeVisible({ timeout: 10_000 });

      const eventId = `evt-${Date.now()}`;
      const envelope = JSON.stringify({
        event_id: eventId,
        type: 'player.connected',
        ts: new Date().toISOString(),
        payload: { test: true, marker: eventId },
      });
      redisCmd(['XADD', `events:server:${targetId}`, '*', 'envelope', envelope]);

      await expect(page.locator(`text=${eventId}`).first()).toBeVisible({ timeout: 8_000 });
    } finally {
      redisCmd(['DEL', `events:server:${targetId}`]);
      deleteSyntheticServer(targetId);
    }
  });

  test('e) configs page banner appears when file changes externally', async ({ page, request }) => {
    const realId = pickServerId();
    if (!realId) {
      test.skip(true, 'no real server — case requires a server with seeded configs');
      return;
    }
    await attachOwnerCookie(page);
    await page.goto(`/servers/${realId}/configs`);

    const adminsBtn = page.locator('button:has-text("Admins.cfg")').first();
    await expect(adminsBtn).toBeVisible({ timeout: 10_000 });
    await adminsBtn.click();
    await page.waitForTimeout(2000);

    const apiHeaders = { Cookie: `__Host-sid=${ownerCookie}` };
    const getResp = await request.get(`/api/v1/servers/${realId}/configs/Admins.cfg`, {
      headers: apiHeaders,
      ignoreHTTPSErrors: true,
    });
    const original = ((await getResp.json()) as { content: string }).content;

    const externallyEdited = `${original}\n// live-refresh probe ${Date.now()}\n`;

    try {
      const put = await request.put(`/api/v1/servers/${realId}/configs/Admins.cfg`, {
        data: { content: externallyEdited, message: 'live-refresh-spec external write' },
        headers: apiHeaders,
        ignoreHTTPSErrors: true,
      });
      expect(put.ok(), await put.text()).toBe(true);

      const banner = page.locator('[data-testid="external-change-banner"]');
      await expect(banner).toBeVisible({ timeout: 14_000 });

      await banner.locator('button:has-text("Загрузить")').click();
      await expect(banner).toBeHidden({ timeout: 4_000 });
    } finally {
      const restore = await request.put(`/api/v1/servers/${realId}/configs/Admins.cfg`, {
        data: { content: original, message: 'live-refresh-spec restore' },
        headers: apiHeaders,
        ignoreHTTPSErrors: true,
      });
      expect(restore.ok()).toBe(true);
    }
  });

  test('f) audit page surfaces a new audit entry within one poll window', async ({ page }) => {
    await attachOwnerCookie(page);
    await page.goto('/audit');

    const firstActionCell = page.locator('table tbody tr td').nth(2);
    await expect(firstActionCell).toBeVisible({ timeout: 10_000 });
    const before = (await firstActionCell.textContent())?.trim();

    // Trigger an audit-logged action via the API using the owner cookie
    await page.evaluate(async (cookie) => {
      await fetch('/api/v1/me', {
        headers: { Cookie: `__Host-sid=${cookie}` },
        credentials: 'include',
        cache: 'no-store',
      });
    }, ownerCookie);

    await expect
      .poll(
        async () => {
          const cell = page.locator('table tbody tr td').nth(2);
          const txt = (await cell.textContent())?.trim();
          return txt !== before;
        },
        {
          message: 'audit table never showed a new entry at the top',
          timeout: 10_000,
          intervals: [500, 1000],
        },
      )
      .toBe(true);
  });

  test('g) players page reflects a new player row within one poll window', async ({ page }) => {
    const steamId = `7656119${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
    const probeName = `lr-probe-${Date.now()}`;
    try {
      await attachOwnerCookie(page);
      await page.goto('/players');
      await page.waitForTimeout(2000);

      runSql(
        `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized) VALUES (${steamId}, '${probeName}', '${probeName.toLowerCase()}')`,
      );
      runSql(
        `INSERT INTO player_name_history (steam_id64, name, name_normalized) VALUES (${steamId}, '${probeName}', '${probeName.toLowerCase()}')`,
      );

      await expect(page.locator(`text=${probeName}`).first()).toBeVisible({ timeout: 12_000 });
    } finally {
      runSql(`DELETE FROM player_name_history WHERE steam_id64=${steamId}`);
      runSql(`DELETE FROM players WHERE steam_id64=${steamId}`);
    }
  });

  test('h) account page reflects external canonical_name change within 35 s', async ({ page }) => {
    test.setTimeout(60_000);
    await attachOwnerCookie(page);
    await page.goto('/settings/account');

    // Ник переехал из блока «Профиль» в шапку страницы; проверяется именно она,
    // а не вся страница — имя игрока стоит ещё и в меню пользователя вверху, и
    // совпадение там прошло бы мимо того, что этот тест проверяет.
    const pageHeader = page
      .locator('header')
      .filter({ has: page.getByRole('heading', { level: 1, name: 'Аккаунт' }) });
    await expect(pageHeader).toBeVisible({ timeout: 10_000 });

    const origName = runSql(`SELECT canonical_name FROM players WHERE steam_id64=${ownerUid}`);
    const newName = `LR Renamed ${Date.now()}`;
    try {
      runSql(`UPDATE players SET canonical_name='${newName}' WHERE steam_id64=${ownerUid}`);
      await expect(pageHeader.locator(`text=${newName}`).first()).toBeVisible({
        timeout: 35_000,
      });
    } finally {
      runSql(`UPDATE players SET canonical_name='${origName}' WHERE steam_id64=${ownerUid}`);
    }
  });

  test('i) LiveIndicator ticks on every polling page', async ({ page }) => {
    await attachOwnerCookie(page);
    const realId = pickServerId();

    // `/settings/account` в списке не значится: индикатор живости с неё убран —
    // страница не про наблюдение за меняющимися данными, а её опрос раз в
    // полминуты проверяет тест (h) выше. С её уходом в списке остались только
    // страницы с частым опросом, и отдельная ветка ожидания для редкого больше
    // ни на что не приходится.
    const pages = ['/dashboard', '/servers', '/audit', '/players'];
    if (realId) {
      pages.push(`/servers/${realId}`, `/servers/${realId}/events`, `/servers/${realId}/configs`);
    }

    for (const url of pages) {
      await page.goto(url);
      await expectIndicatorTicks(page, 12_000);
    }
  });
});
