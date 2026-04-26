import { expect, test } from './_fixtures';

const ARCHIVE_ID = '019dc169-1111-7000-a000-000000000001';
const NEW_SERVER_ID = '019dc169-2222-7000-a000-000000000002';

const archiveListEmpty = { items: [], total: 0 };

const archiveListPopulated = {
  items: [
    {
      id: ARCHIVE_ID,
      display_name: 'Archived Squad #1',
      slug: 'archived-1',
      description: null,
      status: 'stopped',
      tags: [],
      created_at: '2026-04-20T10:00:00.000Z',
      deleted_at: '2026-04-26T08:00:00.000Z',
      deleted_by_steam_id64: '76561199001234567',
      deletion_backup_marker_id: '019dc169-3333-7000-a000-000000000003',
    },
  ],
  total: 1,
};

const archiveDetail = {
  server: {
    id: ARCHIVE_ID,
    display_name: 'Archived Squad #1',
    slug: 'archived-1',
    description: null,
    deleted_at: '2026-04-26T08:00:00.000Z',
    deleted_by_steam_id64: '76561199001234567',
    deletion_backup_marker_id: '019dc169-3333-7000-a000-000000000003',
    tags: [],
  },
  settings: {
    install_path: '/squad',
    game_port: 7787,
    query_port: 27165,
    beacon_port: 15000,
    rcon_port: 21114,
    max_players: 80,
    tickrate: 60,
    multihome: '0.0.0.0',
  },
  backups: [
    {
      id: 'cfgver-001',
      filename: 'Server.cfg',
      sha256_hex: 'aabbccdd112233445566778899aabbccddeeff00',
      message: 'deletion-backup-marker',
      created_at: '2026-04-26T08:00:00.000Z',
      author_steam_id64: '76561199001234567',
      author_label: 'steam:76561199001234567',
    },
    {
      id: 'cfgver-002',
      filename: 'Admins.cfg',
      sha256_hex: 'ffeeddccbbaa9988776655443322110011223344',
      message: 'deletion-backup-marker',
      created_at: '2026-04-26T08:00:00.000Z',
      author_steam_id64: '76561199001234567',
      author_label: 'steam:76561199001234567',
    },
  ],
};

const serverCfgContent = {
  id: 'cfgver-001',
  filename: 'Server.cfg',
  content: 'ServerName="Archived Squad #1"\nMaxPlayers=80\n',
  sha256_hex: 'aabbccdd112233445566778899aabbccddeeff00',
  created_at: '2026-04-26T08:00:00.000Z',
  message: 'deletion-backup-marker',
};

test.describe('servers archive page (mocked)', () => {
  test('empty state renders «Нет удалённых серверов»', async ({ ownerPage }) => {
    await ownerPage.route('**/api/v1/servers/archive', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(archiveListEmpty),
      });
    });
    await ownerPage.goto('/servers/archive');
    await expect(ownerPage.locator('h1')).toContainText('Архив серверов');
    await expect(ownerPage.locator('text=Нет удалённых серверов')).toBeVisible();
  });

  test('populated list renders table with rows', async ({ ownerPage }) => {
    await ownerPage.route('**/api/v1/servers/archive', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(archiveListPopulated),
      });
    });
    await ownerPage.goto('/servers/archive');
    await expect(ownerPage.locator('table')).toContainText('Archived Squad #1');
    await expect(ownerPage.locator('table')).toContainText('archived-1');
    await expect(ownerPage.locator('table')).toContainText('76561199001234567');
  });

  test('detail page lists backup files and opens content on click', async ({ ownerPage }) => {
    await ownerPage.route(`**/api/v1/servers/archive/${ARCHIVE_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(archiveDetail),
      });
    });
    await ownerPage.route(
      `**/api/v1/servers/archive/${ARCHIVE_ID}/configs/Server.cfg`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(serverCfgContent),
        });
      },
    );

    await ownerPage.goto(`/servers/archive/${ARCHIVE_ID}`);
    await expect(ownerPage.locator('h1')).toContainText('Archived Squad #1');
    await expect(ownerPage.locator('table')).toContainText('Server.cfg');
    await expect(ownerPage.locator('table')).toContainText('Admins.cfg');

    await ownerPage.getByRole('button', { name: 'Server.cfg' }).click();
    await expect(ownerPage.locator('[role="dialog"]')).toBeVisible();
    await expect(ownerPage.locator('[role="dialog"]')).toContainText('ServerName=');
    await ownerPage.locator('[role="dialog"] header button:has-text("Закрыть")').click();
    await expect(ownerPage.locator('[role="dialog"]')).toHaveCount(0);
  });

  test('restore wizard requires slug and posts on submit', async ({ ownerPage }) => {
    await ownerPage.route(`**/api/v1/servers/archive/${ARCHIVE_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(archiveDetail),
      });
    });

    let restoreCalled = false;
    await ownerPage.route(`**/api/v1/servers/archive/${ARCHIVE_ID}/restore`, async (route) => {
      restoreCalled = true;
      const req = route.request();
      const body = req.postDataJSON() as { slug: string; display_name?: string };
      expect(body.slug).toMatch(/^[a-z0-9-]+$/);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: NEW_SERVER_ID,
          archive_id: ARCHIVE_ID,
          slug: body.slug,
          display_name: body.display_name ?? '',
          status: 'pending',
          next_steps: [],
        }),
      });
    });
    await ownerPage.route(`**/api/v1/servers/${NEW_SERVER_ID}/install`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await ownerPage.goto(`/servers/archive/${ARCHIVE_ID}/restore`);
    const slugInput = ownerPage.locator('input[pattern="^[a-z0-9-]+$"]');
    await expect(slugInput).toHaveValue('archived-1-restored');
    await ownerPage.getByRole('button', { name: 'Создать новый сервер из бэкапа' }).click();

    await expect.poll(() => restoreCalled, { timeout: 5_000 }).toBe(true);
    await expect(ownerPage.locator('h1')).toContainText(/Создаём сервер|Установка/);
  });
});

test.describe('connection banner (mocked)', () => {
  test('shows «Связь с панелью потеряна» when WS does not connect', async ({ ownerPage }) => {
    await ownerPage.addInitScript(() => {
      class StubWebSocket {
        readyState = 0;
        url: string;
        onopen: ((ev: Event) => void) | null = null;
        onclose: ((ev: CloseEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        constructor(url: string) {
          this.url = url;
        }
        send() {
          /* noop */
        }
        close() {
          this.readyState = 3;
          if (this.onclose) this.onclose(new CloseEvent('close', { code: 1006, reason: 'stub' }));
        }
        addEventListener() {
          /* noop */
        }
        removeEventListener() {
          /* noop */
        }
      }
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: StubWebSocket,
      });
    });

    await ownerPage.goto('/dashboard');
    const banner = ownerPage.locator('[data-testid="connection-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('Связь с панелью потеряна');
  });
});
