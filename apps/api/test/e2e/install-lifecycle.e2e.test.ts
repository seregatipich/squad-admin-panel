/**
 * Full install → run → edit-config → stop → delete lifecycle against a
 * live panel stack. This is the test suite the project bets on — any
 * regression on the critical path (docker run args, depot seeding, RCON
 * AUTH, config editor allowlist) fails here first.
 *
 * Requires:
 *   - docker compose up -d (api, web, workers, postgres, redis, caddy)
 *   - systemctl is-active panel-host-bridge
 *   - depot already populated in squad-depot volume (first run only takes
 *     ~25 min; the test does NOT re-download to keep CI feasible)
 *   - PANEL_TEST_COOKIE env with a valid Owner session cookie value
 *
 * Run: pnpm --filter @squad/api test:e2e
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newClient, randomPorts, shouldSkip } from './lib/client.js';

interface ServerResponse {
  server: { id: string; status: string; display_name: string; slug: string };
  settings: { game_port: number; rcon_port: number } | null;
  rcon_status: { state: string; player_count?: number };
}

interface ConfigItem {
  name: string;
  size: number;
  sha256: string | null;
  behavior: string;
  exists: boolean;
}

interface ConfigBody {
  name: string;
  content: string;
  sha256: string;
  behavior: string;
}

const skip = shouldSkip();

describe.skipIf(skip.skip)('install → run → edit → stop → delete', () => {
  const api = newClient();
  const ports = randomPorts();
  const suffix = Date.now().toString(36);
  const slug = `e2e-${suffix}`;
  let serverId = '';

  beforeAll(() => {
    console.log(`[e2e] using ports ${JSON.stringify(ports)}`);
    console.log(`[e2e] slug=${slug}`);
  });

  afterAll(async () => {
    // best-effort teardown so a half-failed run doesn't leak containers
    if (serverId) {
      await api.fetch(`/api/v1/servers/${serverId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  });

  it('POST /api/v1/servers creates a pending row', async () => {
    const body = {
      display_name: `E2E ${suffix}`,
      slug,
      description: 'e2e lifecycle test',
      max_players: 20,
      ...ports,
    };
    const res = await api.json<{ id: string; status: string }>('/api/v1/servers', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(res.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.status).toBe('pending');
    serverId = res.id;
  });

  it('POST /api/v1/servers/:id/install seeds configs + starts container', async () => {
    const r = await api.json<{ status: string }>(`/api/v1/servers/${serverId}/install`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(r.status).toBe('installing');

    // Poll until done. depotPopulated skips steamcmd, so the bottleneck is
    // seedConfigs (fast) + ufw + container_run + Squad boot. Give 3 min.
    const lines = await api.waitFor(
      async () =>
        api.json<{ lines: { step: string; message: string }[] }>(
          `/api/v1/servers/${serverId}/install/progress`,
        ),
      (v) => v.lines.some((l) => l.step === 'done' || l.step === 'error'),
      { timeoutMs: 180_000, intervalMs: 2000, label: 'install progress' },
    );
    const terminal =
      lines.lines.findLast?.((l) => l.step === 'done' || l.step === 'error') ??
      [...lines.lines].reverse().find((l) => l.step === 'done' || l.step === 'error');
    expect(terminal?.step, `install emitted error: ${terminal?.message}`).toBe('done');
  });

  it('status-reconciler flips DB status to running', async () => {
    const row = await api.waitFor<ServerResponse>(
      () => api.json<ServerResponse>(`/api/v1/servers/${serverId}`),
      (v) => v.server.status === 'running',
      { timeoutMs: 60_000, label: 'wait for running status' },
    );
    expect(row.server.status).toBe('running');
  });

  it('worker-rcon establishes connection (rcon_status.state=connected)', async () => {
    const row = await api.waitFor<ServerResponse>(
      () => api.json<ServerResponse>(`/api/v1/servers/${serverId}`),
      (v) => v.rcon_status?.state === 'connected',
      { timeoutMs: 90_000, intervalMs: 2000, label: 'wait for RCON connected' },
    );
    expect(row.rcon_status.state).toBe('connected');
    expect(typeof row.rcon_status.player_count).toBe('number');
  });

  it('GET /configs lists 19 Squad cfg files', async () => {
    const r = await api.json<{ items: ConfigItem[] }>(`/api/v1/servers/${serverId}/configs`);
    expect(r.items).toHaveLength(19);
    const serverCfg = r.items.find((i) => i.name === 'Server.cfg');
    expect(serverCfg?.exists).toBe(true);
    expect(serverCfg?.behavior).toBe('requires_restart');
    const admins = r.items.find((i) => i.name === 'Admins.cfg');
    expect(admins?.behavior).toBe('hot_reload');
  });

  it('PUT /configs/Admins.cfg atomically updates content + sha256', async () => {
    const before = await api.json<ConfigBody>(`/api/v1/servers/${serverId}/configs/Admins.cfg`);
    const newContent = `${before.content}\n// e2e-marker-${suffix}\n`;
    const put = await api.json<{ ok: true; previous_sha256: string | null; sha256: string }>(
      `/api/v1/servers/${serverId}/configs/Admins.cfg`,
      { method: 'PUT', body: JSON.stringify({ content: newContent }) },
    );
    expect(put.ok).toBe(true);
    expect(put.sha256).toBe(createHash('sha256').update(newContent).digest('hex'));
    expect(put.previous_sha256).toBe(before.sha256);

    const after = await api.json<ConfigBody>(`/api/v1/servers/${serverId}/configs/Admins.cfg`);
    expect(after.content).toBe(newContent);
    expect(after.sha256).toBe(put.sha256);
  });

  it('PUT a non-whitelisted filename → 400', async () => {
    const r = await api.fetch(`/api/v1/servers/${serverId}/configs/not-real.cfg`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'x' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /stop gracefully shuts down, status → stopped ≤ 90 s', async () => {
    await api.json(`/api/v1/servers/${serverId}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const row = await api.waitFor<ServerResponse>(
      () => api.json<ServerResponse>(`/api/v1/servers/${serverId}`),
      (v) => v.server.status === 'stopped',
      { timeoutMs: 90_000, intervalMs: 2000, label: 'wait for stopped status' },
    );
    expect(row.server.status).toBe('stopped');
  });

  it('DELETE removes the DB row + container', async () => {
    const r = await api.fetch(`/api/v1/servers/${serverId}`, { method: 'DELETE' });
    expect([200, 204]).toContain(r.status);
    const after = await api.fetch(`/api/v1/servers/${serverId}`);
    expect(after.status).toBe(404);
    serverId = ''; // signal afterAll to skip cleanup
  });
});

if (skip.skip) {
  console.warn(`[e2e] SKIPPED: ${skip.reason}`);
}
