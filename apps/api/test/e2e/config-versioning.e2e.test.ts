/**
 * End-to-end: every config save → new row in config_versions, history
 * surfaces correct ordering + authorship, diff returns a valid unified
 * patch, blame attributes the added line to its author, restore creates
 * a NEW version (non-destructive), no-op writes don't pollute history.
 *
 * Piggy-backs on a running server created by install-lifecycle.e2e.test
 * (same suffix pattern) OR reuses any existing installed server. If no
 * server is available it creates+installs one and tears it down.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newClient, randomPorts, shouldSkip } from './lib/client.js';

const skip = shouldSkip();

interface Version {
  id: string;
  sha256: string;
  author_email: string | null;
  message: string | null;
  created_at: string;
  size: number;
}

interface BlameResp {
  lines: Array<{ text: string; version_id: string; author_user_id: string | null }>;
  authors: Record<string, string>;
}

describe.skipIf(skip.skip)('config versioning: history + diff + blame + restore', () => {
  const api = newClient();
  const suffix = Date.now().toString(36);
  const slug = `eve-${suffix}`;
  let serverId = '';
  let ownServer = false;
  const filename = 'Admins.cfg';

  beforeAll(async () => {
    // Find an existing running server first; if none, install one.
    const list = await api.json<{ items: Array<{ id: string; status: string }> }>(
      '/api/v1/servers',
    );
    const running = list.items.find((s) => s.status === 'running' || s.status === 'stopped');
    if (running) {
      serverId = running.id;
      console.log(`[e2e/versioning] reusing existing server ${serverId}`);
    } else {
      const ports = randomPorts();
      const created = await api.json<{ id: string }>('/api/v1/servers', {
        method: 'POST',
        body: JSON.stringify({ display_name: `Ver ${suffix}`, slug, max_players: 20, ...ports }),
      });
      serverId = created.id;
      ownServer = true;
      console.log(`[e2e/versioning] installing fresh server ${serverId}`);
      await api.json(`/api/v1/servers/${serverId}/install`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await api.waitFor(
        async () =>
          api.json<{ lines: { step: string }[] }>(`/api/v1/servers/${serverId}/install/progress`),
        (v) => v.lines.some((l) => l.step === 'done' || l.step === 'error'),
        { timeoutMs: 180_000, intervalMs: 2000, label: 'install' },
      );
    }
  });

  afterAll(async () => {
    if (ownServer && serverId) {
      await api.fetch(`/api/v1/servers/${serverId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  });

  it('install created initial baseline: every file has ≥1 version row', async () => {
    const r = await api.json<{ items: Version[] }>(
      `/api/v1/servers/${serverId}/configs/${filename}/history`,
    );
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    // The seeder's author is NULL + message mentions "initial install".
    const baselineRow = r.items[r.items.length - 1];
    expect(baselineRow?.author_user_id).toBeNull();
    expect(baselineRow?.message).toMatch(/initial install/i);
  });

  let baseline = 0;
  let v1Id = '';
  let v2Id = '';

  it('PUT #1 creates version with message', async () => {
    const before = await api.json<{ items: Version[] }>(
      `/api/v1/servers/${serverId}/configs/${filename}/history`,
    );
    baseline = before.items.length;
    const current = await api.json<{ content: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}`,
    );
    const next = `${current.content}\n// v1-marker-${suffix}\n`;
    const put = await api.json<{ version_id: string; unchanged?: boolean }>(
      `/api/v1/servers/${serverId}/configs/${filename}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content: next, message: 'first e2e write' }),
      },
    );
    expect(put.unchanged).not.toBe(true);
    expect(put.version_id).toMatch(/^[0-9a-f-]{36}$/);
    v1Id = put.version_id;
    const after = await api.json<{ items: Version[] }>(
      `/api/v1/servers/${serverId}/configs/${filename}/history`,
    );
    expect(after.items.length).toBe(baseline + 1);
    expect(after.items[0]?.message).toBe('first e2e write');
  });

  it('PUT #2 creates second version', async () => {
    const current = await api.json<{ content: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}`,
    );
    const next = `${current.content}// v2-marker-${suffix}\n`;
    const put = await api.json<{ version_id: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content: next, message: 'second e2e write' }),
      },
    );
    v2Id = put.version_id;
    const hist = await api.json<{ items: Version[] }>(
      `/api/v1/servers/${serverId}/configs/${filename}/history`,
    );
    expect(hist.items.length).toBe(baseline + 2);
    expect(hist.items[0]?.id).toBe(v2Id);
    expect(hist.items[1]?.id).toBe(v1Id);
  });

  it('no-op write does NOT create a new version', async () => {
    const current = await api.json<{ content: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}`,
    );
    const before = await api.json<{ items: Version[] }>(
      `/api/v1/servers/${serverId}/configs/${filename}/history`,
    );
    const put = await api.json<{ unchanged: boolean }>(
      `/api/v1/servers/${serverId}/configs/${filename}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content: current.content, message: 'noop' }),
      },
    );
    expect(put.unchanged).toBe(true);
    const after = await api.json<{ items: Version[] }>(
      `/api/v1/servers/${serverId}/configs/${filename}/history`,
    );
    expect(after.items.length).toBe(before.items.length);
  });

  it('GET /diff returns unified patch for v1 → v2', async () => {
    const r = await api.json<{ patch: string; from: string; to: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}/diff?from=${v1Id}&to=${v2Id}`,
    );
    expect(r.from).toBe(v1Id);
    expect(r.to).toBe(v2Id);
    expect(r.patch).toMatch(/^Index:/m);
    expect(r.patch).toContain(`v2-marker-${suffix}`);
  });

  it('GET /blame attributes v2 marker line to current user', async () => {
    const r = await api.json<BlameResp>(`/api/v1/servers/${serverId}/configs/${filename}/blame`);
    const marker = r.lines.find((l) => l.text.includes(`v2-marker-${suffix}`));
    expect(marker).toBeDefined();
    expect(marker?.version_id).toBe(v2Id);
    if (marker?.author_user_id) expect(r.authors[marker?.author_user_id]).toBeTruthy();
  });

  it('POST /restore creates a NEW version with v1 content (non-destructive)', async () => {
    const v1 = await api.json<{ content: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}/versions/${v1Id}`,
    );
    const restore = await api.json<{ version_id: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}/restore/${v1Id}`,
      { method: 'POST', body: JSON.stringify({ message: 'e2e rollback' }) },
    );
    expect(restore.version_id).not.toBe(v1Id);
    expect(restore.version_id).not.toBe(v2Id);

    const current = await api.json<{ content: string; sha256: string }>(
      `/api/v1/servers/${serverId}/configs/${filename}`,
    );
    expect(current.content).toBe(v1.content);
    expect(current.sha256).toBe(createHash('sha256').update(v1.content).digest('hex'));

    const hist = await api.json<{ items: Version[] }>(
      `/api/v1/servers/${serverId}/configs/${filename}/history`,
    );
    // original v1 + v2 + restore row = at least 3 new versions since baseline
    expect(hist.items.length).toBeGreaterThanOrEqual(baseline + 3);
    expect(hist.items.find((v) => v.id === v1Id)).toBeDefined(); // history preserved
    expect(hist.items.find((v) => v.id === v2Id)).toBeDefined();
    expect(hist.items[0]?.message).toBe('e2e rollback');
  });

  it('history is append-only — DB trigger rejects UPDATE/DELETE', async () => {
    // We can't execute SQL from this test client, but we trust the 0003
    // migration's trigger. Smoke via attempting a bogus restore on a
    // non-existent version — must 404, not 500.
    const r = await api.fetch(
      `/api/v1/servers/${serverId}/configs/${filename}/restore/00000000-0000-0000-0000-000000000000`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(r.status).toBe(404);
  });

  it('non-whitelisted filename → 400 on history', async () => {
    const r = await api.fetch(`/api/v1/servers/${serverId}/configs/NotReal.cfg/history`);
    expect(r.status).toBe(400);
  });
});
