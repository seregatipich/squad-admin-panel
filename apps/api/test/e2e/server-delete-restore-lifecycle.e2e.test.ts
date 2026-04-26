/**
 * Full delete → archive → restore → configs-overlay lifecycle against a
 * live panel stack. Bundle H of the server-deletion-restore-liveness epic.
 *
 * Sequence:
 *   1. Install a server, edit Admins.cfg with a unique marker.
 *   2. DELETE → expect backup_marker_id, container_removed, configs_dir_removed.
 *   3. /archive list + detail expose the server and the backup of Admins.cfg.
 *   4. POST /archive/:id/restore creates a new server (different slug),
 *      install it, then POST /restore-configs overlays the backup.
 *   5. New server's Admins.cfg matches the marker exactly. Rcon.cfg skipped.
 *
 * Requires:
 *   - docker compose stack up + panel-host-bridge active
 *   - depot already populated in squad-depot volume
 *   - PANEL_TEST_COOKIE env (Owner session) and optionally PANEL_TEST_URL
 *
 * Run: pnpm --filter @squad/api test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newClient, randomPorts, shouldSkip } from './lib/client.js';

interface ServerResponse {
  server: { id: string; status: string; display_name: string; slug: string };
  rcon_status: { state: string; player_count?: number };
}

interface ConfigBody {
  name: string;
  content: string;
  sha256: string;
  behavior: string;
}

interface DeleteResponse {
  ok: boolean;
  backup_marker_id: string | null;
  files_backed_up: number;
  container_removed: boolean;
  configs_dir_removed: boolean;
  saved_dir_removed: boolean;
  ufw_rules_removed: number;
  errors: Array<{ phase: string; error: string }>;
}

interface ArchiveListItem {
  id: string;
  display_name: string;
  slug: string;
  deleted_at: string;
  deletion_backup_marker_id: string | null;
}

interface ArchiveDetail {
  server: { id: string; slug: string; deleted_at: string };
  backups: Array<{ id: string; filename: string; sha256_hex: string; message: string | null }>;
}

interface ArchiveConfigBody {
  id: string;
  filename: string;
  content: string;
  sha256_hex: string;
}

interface RestoreServerResponse {
  id: string;
  archive_id: string;
  slug: string;
  display_name: string;
  status: string;
}

interface RestoreConfigsResponse {
  ok: boolean;
  archive_server_id: string;
  files_restored: number;
  files_skipped: string[];
  files_missing: string[];
  config_version_ids: string[];
  errors: Array<{ file: string; error: string }>;
}

const skip = shouldSkip();

describe.skipIf(skip.skip)('server delete → archive → restore → configs overlay lifecycle', () => {
  const api = newClient();
  const ports = randomPorts();
  const suffix = Date.now().toString(36);
  const slug = `e2e-del-${suffix}`;
  let serverId = '';
  let restoredServerId = '';
  let editedAdminsContent = '';

  beforeAll(() => {
    console.log(`[e2e/delete-restore] using ports ${JSON.stringify(ports)} slug=${slug}`);
  });

  afterAll(async () => {
    if (restoredServerId) {
      await api
        .fetch(`/api/v1/servers/${restoredServerId}`, { method: 'DELETE' })
        .catch(() => undefined);
    }
    if (serverId) {
      await api.fetch(`/api/v1/servers/${serverId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  });

  it('installs a server', async () => {
    const created = await api.json<{ id: string; status: string }>('/api/v1/servers', {
      method: 'POST',
      body: JSON.stringify({
        display_name: `E2E DR ${suffix}`,
        slug,
        description: 'e2e delete+restore lifecycle',
        max_players: 20,
        ...ports,
      }),
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    serverId = created.id;

    const install = await api.json<{ status: string }>(`/api/v1/servers/${serverId}/install`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(install.status).toBe('installing');

    const progress = await api.waitFor(
      async () =>
        api.json<{ lines: { step: string; message: string }[] }>(
          `/api/v1/servers/${serverId}/install/progress`,
        ),
      (v) => v.lines.some((l) => l.step === 'done' || l.step === 'error'),
      { timeoutMs: 200_000, intervalMs: 2000, label: 'install progress' },
    );
    const terminal =
      progress.lines.findLast?.((l) => l.step === 'done' || l.step === 'error') ??
      [...progress.lines].reverse().find((l) => l.step === 'done' || l.step === 'error');
    expect(terminal?.step, `install emitted error: ${terminal?.message}`).toBe('done');

    const row = await api.waitFor<ServerResponse>(
      () => api.json<ServerResponse>(`/api/v1/servers/${serverId}`),
      (v) => v.server.status === 'running',
      { timeoutMs: 60_000, label: 'wait for running status' },
    );
    expect(row.server.status).toBe('running');
  });

  it('edits Admins.cfg to a known unique value', async () => {
    editedAdminsContent =
      `// e2e delete-restore marker ${suffix}\n` +
      `Group=SuperAdmin:ChangeMap\n` +
      `Admin=76561198000000001:SuperAdmin\n`;
    const put = await api.json<{ ok?: true; sha256?: string; version_id?: string }>(
      `/api/v1/servers/${serverId}/configs/Admins.cfg`,
      {
        method: 'PUT',
        body: JSON.stringify({ content: editedAdminsContent, message: 'e2e baseline' }),
      },
    );
    expect(put.version_id ?? put.sha256).toBeTruthy();
    const after = await api.json<ConfigBody>(`/api/v1/servers/${serverId}/configs/Admins.cfg`);
    expect(after.content).toBe(editedAdminsContent);
  });

  it('soft-deletes the server, captures backup, removes container + files', async () => {
    const res = await api.fetch(`/api/v1/servers/${serverId}`, { method: 'DELETE' });
    expect([200, 204]).toContain(res.status);
    const body = (await res.json()) as DeleteResponse;
    expect(body.ok).toBe(true);
    expect(body.backup_marker_id).toMatch(/^[0-9a-f-]{36}$/);
    // 19 .cfg files in ALLOWED_CONFIG_FILES; backup loop is best-effort,
    // but a fresh install seeds them all so we should see ≥ 18.
    expect(body.files_backed_up).toBeGreaterThanOrEqual(18);
    expect(body.container_removed).toBe(true);
    expect(body.configs_dir_removed).toBe(true);
    expect(body.saved_dir_removed).toBe(true);
    if (body.errors.length > 0) {
      console.warn(
        `[e2e/delete-restore] DELETE reported non-fatal errors: ${JSON.stringify(body.errors)}`,
      );
      for (const e of body.errors) {
        expect(e.phase, `unexpected fatal phase failure: ${JSON.stringify(e)}`).toMatch(/^ufw_/);
      }
    }

    const after = await api.fetch(`/api/v1/servers/${serverId}`);
    expect(after.status).toBe(404);

    const list = await api.json<{ items: Array<{ id: string }> }>('/api/v1/servers');
    expect(list.items.some((s) => s.id === serverId)).toBe(false);
  });

  it('archive list shows the deleted server with the right backup count', async () => {
    const list = await api.json<{ items: ArchiveListItem[] }>('/api/v1/servers/archive');
    const archived = list.items.find((s) => s.id === serverId);
    expect(archived).toBeDefined();
    expect(archived?.slug).toBe(slug);
    expect(archived?.deletion_backup_marker_id).toMatch(/^[0-9a-f-]{36}$/);

    const detail = await api.json<ArchiveDetail>(`/api/v1/servers/archive/${serverId}`);
    expect(detail.server.id).toBe(serverId);
    const filenames = detail.backups.map((b) => b.filename);
    expect(filenames).toContain('Admins.cfg');
    expect(filenames).toContain('Server.cfg');
    expect(filenames).toContain('Rcon.cfg');

    const adminsBackup = await api.json<ArchiveConfigBody>(
      `/api/v1/servers/archive/${serverId}/configs/Admins.cfg`,
    );
    expect(adminsBackup.content).toBe(editedAdminsContent);
  });

  it('restores into a new server with a fresh slug', async () => {
    const newSlug = `e2e-restored-${suffix}`;
    const restore = await api.json<RestoreServerResponse>(
      `/api/v1/servers/archive/${serverId}/restore`,
      {
        method: 'POST',
        body: JSON.stringify({ slug: newSlug }),
      },
    );
    expect(restore.archive_id).toBe(serverId);
    expect(restore.slug).toBe(newSlug);
    expect(restore.id).toMatch(/^[0-9a-f-]{36}$/);
    restoredServerId = restore.id;

    const install = await api.json<{ status: string }>(
      `/api/v1/servers/${restoredServerId}/install`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(install.status).toBe('installing');
    const progress = await api.waitFor(
      async () =>
        api.json<{ lines: { step: string; message: string }[] }>(
          `/api/v1/servers/${restoredServerId}/install/progress`,
        ),
      (v) => v.lines.some((l) => l.step === 'done' || l.step === 'error'),
      { timeoutMs: 200_000, intervalMs: 2000, label: 'restored install progress' },
    );
    const terminal =
      progress.lines.findLast?.((l) => l.step === 'done' || l.step === 'error') ??
      [...progress.lines].reverse().find((l) => l.step === 'done' || l.step === 'error');
    expect(terminal?.step, `restored install emitted error: ${terminal?.message}`).toBe('done');

    const overlay = await api.json<RestoreConfigsResponse>(
      `/api/v1/servers/${restoredServerId}/restore-configs`,
      {
        method: 'POST',
        body: JSON.stringify({ from_archive_id: serverId }),
      },
    );
    expect(overlay.ok).toBe(true);
    expect(overlay.archive_server_id).toBe(serverId);
    expect(overlay.files_restored).toBeGreaterThanOrEqual(17);
    expect(overlay.files_skipped).toContain('Rcon.cfg');
    expect(overlay.errors).toEqual([]);

    const admins = await api.json<ConfigBody>(
      `/api/v1/servers/${restoredServerId}/configs/Admins.cfg`,
    );
    expect(admins.content).toBe(editedAdminsContent);
  });
});

if (skip.skip) {
  console.warn(`[e2e/delete-restore] SKIPPED: ${skip.reason}`);
}
