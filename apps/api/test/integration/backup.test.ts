import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

// Test-range steam id so the parallel test:cov shared DB is never contended
// (test-isolation.regression.test.ts requires steamId64-scoped mutations).
const OWNER_STEAM_ID = 76561198000000219n;
const SNAPSHOT_ID = 'a1b2c3d4';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

/** Strip the owner's role so it loses `host:manage` (403 path). */
async function demoteOwner(): Promise<void> {
  if (!h.seed.ownerSteamId64) throw new Error('seed owner missing');
  await h.db
    .update(players)
    .set({ roleId: null })
    .where(eq(players.steamId64, h.seed.ownerSteamId64));
  if (!h.seed.ownerPlayerId) throw new Error('seed owner missing');
  invalidatePermissionCache(h.seed.ownerPlayerId);
}

describe('GET /api/v1/host/backups', () => {
  it('lists restic snapshots for an operator with host:manage', async () => {
    h.bridge.backupSnapshots = async () => ({
      snapshots: [
        {
          id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
          short_id: SNAPSHOT_ID,
          time: '2026-07-24T03:00:00Z',
          hostname: 'tk104',
          paths: ['/data'],
          tags: ['cron'],
        },
      ],
    });
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as { snapshots: Array<{ short_id: string }> };
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]?.short_id).toBe(SNAPSHOT_ID);
  });

  it('returns 502 when the bridge is unreachable', async () => {
    h.bridge.backupSnapshots = async () => {
      throw new Error('bridge socket ECONNREFUSED');
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({ error: 'backup_list_failed' });
  });

  it('coerces a non-Error bridge failure into the detail string', async () => {
    h.bridge.backupSnapshots = async () => {
      // biome-ignore lint/style/useThrowOnlyError: exercises the String(err) fallback branch
      throw 'raw string failure';
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({
      error: 'backup_list_failed',
      detail: 'raw string failure',
    });
  });

  it('returns 403 for a user without host:manage', async () => {
    await demoteOwner();
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('returns 401 without a session', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/host/backups' });
    expect(resp.statusCode).toBe(401);
  });
});

describe('POST /api/v1/host/backups', () => {
  it('triggers a backup and writes a backup.run audit row', async () => {
    let calls = 0;
    h.bridge.backupRun = async () => {
      calls++;
      return { exit_code: 0 };
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ ok: true, exit_code: 0 });
    expect(calls).toBe(1);
    await assertAuditRow(h, { action: 'backup.run', resource: 'backup' });
  });

  it('returns 502 when the backup run fails', async () => {
    h.bridge.backupRun = async () => {
      throw new Error('compose run failed');
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({ error: 'backup_run_failed' });
  });

  it('coerces a non-Error backup failure into the detail string', async () => {
    h.bridge.backupRun = async () => {
      // biome-ignore lint/style/useThrowOnlyError: exercises the String(err) fallback branch
      throw 'raw run failure';
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({ error: 'backup_run_failed', detail: 'raw run failure' });
  });

  it('returns 403 for a user without host:manage', async () => {
    await demoteOwner();
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/backups',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('returns 401 without a session', async () => {
    const resp = await h.app.inject({ method: 'POST', url: '/api/v1/host/backups' });
    expect(resp.statusCode).toBe(401);
  });
});

describe('POST /api/v1/host/backups/:id/restore', () => {
  it('restores the selected snapshot when the typed confirm matches and audits it', async () => {
    let restoredWith: string | null = null;
    h.bridge.backupRestore = async ({ snapshot_id }) => {
      restoredWith = snapshot_id;
      return { exit_code: 0 };
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/backups/${SNAPSHOT_ID}/restore`,
      headers: { cookie },
      payload: { confirm: SNAPSHOT_ID },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ ok: true, exit_code: 0 });
    expect(restoredWith).toBe(SNAPSHOT_ID);
    await assertAuditRow(h, { action: 'backup.restore', resource: 'backup' });
  });

  it('rejects a missing confirm token with 400 and never touches the bridge', async () => {
    let called = false;
    h.bridge.backupRestore = async () => {
      called = true;
      return { exit_code: 0 };
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/backups/${SNAPSHOT_ID}/restore`,
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json()).toMatchObject({ error: 'confirm_required' });
    expect(called).toBe(false);
  });

  it('rejects a mismatched confirm token with 400', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/backups/${SNAPSHOT_ID}/restore`,
      headers: { cookie },
      payload: { confirm: 'not-the-id' },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json()).toMatchObject({ error: 'confirm_required' });
  });

  it('returns 502 when the restore fails', async () => {
    h.bridge.backupRestore = async () => {
      throw new Error('restore.sh exit 1');
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/backups/${SNAPSHOT_ID}/restore`,
      headers: { cookie },
      payload: { confirm: SNAPSHOT_ID },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({ error: 'backup_restore_failed' });
  });

  it('coerces a non-Error restore failure into the detail string', async () => {
    h.bridge.backupRestore = async () => {
      // biome-ignore lint/style/useThrowOnlyError: exercises the String(err) fallback branch
      throw 'raw restore failure';
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/backups/${SNAPSHOT_ID}/restore`,
      headers: { cookie },
      payload: { confirm: SNAPSHOT_ID },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({
      error: 'backup_restore_failed',
      detail: 'raw restore failure',
    });
  });

  it('returns 403 for a user without host:manage', async () => {
    await demoteOwner();
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/backups/${SNAPSHOT_ID}/restore`,
      headers: { cookie },
      payload: { confirm: SNAPSHOT_ID },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('returns 401 without a session', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/backups/${SNAPSHOT_ID}/restore`,
      payload: { confirm: SNAPSHOT_ID },
    });
    expect(resp.statusCode).toBe(401);
  });
});
