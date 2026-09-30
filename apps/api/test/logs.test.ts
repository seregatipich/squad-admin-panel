import { players, roles } from '@squad/db/schema';
import { encodeLogEntry, PANEL_LOGS_STREAM } from '@squad/shared-config';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { narrowedOwnerHeaders } from './helpers/narrowed-token.js';
import { VIEWER_PERMISSIONS } from './helpers/viewer-fixture.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000001002n;

let h: IntegrationHarness;
let ownerRoleId: string;

async function seedLogEntries(redis: IntegrationHarness['redis']) {
  const entries = [
    encodeLogEntry({ source: 'api', level: 'info', msg: 'server started' }),
    encodeLogEntry({ source: 'bridge', level: 'warn', msg: 'bridge reconnecting' }),
    encodeLogEntry({
      source: 'rcon',
      level: 'error',
      msg: 'rcon auth failed',
      serverId: 'aaa00000-0000-7000-8000-000000000000',
    }),
    encodeLogEntry({ source: 'depot', level: 'debug', msg: 'depot sync ok' }),
    encodeLogEntry({ source: 'worker', level: 'info', msg: 'heartbeat' }),
  ];

  const ids: string[] = [];
  for (const fields of entries) {
    const args: unknown[] = [PANEL_LOGS_STREAM, 'MAXLEN', '~', '10000', '*'];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    const id = await (redis as { xadd(...a: unknown[]): Promise<string | null> }).xadd(...args);
    if (id) ids.push(id);
  }
  return ids;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
  const [ownerRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role missing — migration 0009 not applied?');
  ownerRoleId = ownerRole.id;
  // No case writes to the stream, so one seeded set serves every case.
  await seedLogEntries(h.redis);
});

afterAll(async () => {
  await h.cleanup();
});

// Two cases demote the seeded owner to Viewer; put it back on Owner.
afterEach(async () => {
  if (!h.seed.ownerSteamId64 || !h.seed.ownerPlayerId) return;
  await h.db
    .update(players)
    .set({ roleId: ownerRoleId })
    .where(eq(players.steamId64, h.seed.ownerSteamId64));
  invalidatePermissionCache(h.seed.ownerPlayerId);
});

describe('GET /api/v1/logs', () => {
  it('returns the most recent entries for Owner (host:view permission)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(5);
  });

  it('returns 401 when unauthenticated', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for a role without host:view permission', async () => {
    const viewerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRows[0]?.id;
    if (!viewerRoleId || !h.seed.ownerSteamId64 || !h.seed.ownerPlayerId) {
      throw new Error('Viewer role missing');
    }

    await h.db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    invalidatePermissionCache(h.seed.ownerPlayerId);

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
  });

  it('filters by source code (src=A returns only api entries)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?src=A',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.entries.every((e: { source: string }) => e.source === 'api')).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by minimum log level (lvl=warn excludes debug and info)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?lvl=warn',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    const levels: string[] = body.entries.map((e: { level: string }) => e.level);
    expect(levels.every((l) => l === 'warn' || l === 'error')).toBe(true);
  });

  it('filters by serverId (srv=aaa returns only that server entries)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?srv=aaa00000-0000-7000-8000-000000000000',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(
      body.entries.every(
        (e: { serverId?: string }) => e.serverId === 'aaa00000-0000-7000-8000-000000000000',
      ),
    ).toBe(true);
  });

  it('rejects an invalid lvl value with 400', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?lvl=verbose',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(400);
  });

  it('rejects limit > 2000 with 400', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?limit=9999',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(400);
  });

  it('rejects limit < 1 with 400', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?limit=0',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(400);
  });

  it('rejects a non-UUID srv with 400', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?srv=not-a-uuid',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(400);
  });

  it('paginates forward with after= cursor', async () => {
    const cookie = await loginAsOwner(h);
    const first = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?limit=2',
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.entries.length).toBeGreaterThanOrEqual(1);

    const oldestId: string = firstBody.entries[firstBody.entries.length - 1].id;
    const next = await h.app.inject({
      method: 'GET',
      url: `/api/v1/logs?limit=10&after=${oldestId}`,
      headers: { cookie },
    });
    expect(next.statusCode).toBe(200);
  });

  it('paginates backward with before= cursor', async () => {
    const cookie = await loginAsOwner(h);
    const first = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?limit=2',
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.entries.length).toBeGreaterThanOrEqual(1);

    const newestId: string = firstBody.entries[0].id;
    const prev = await h.app.inject({
      method: 'GET',
      url: `/api/v1/logs?limit=10&before=${newestId}`,
      headers: { cookie },
    });
    expect(prev.statusCode).toBe(200);
  });

  it('text search via q= filters by message substring', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?q=heartbeat',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(
      body.entries.every((e: { msg: string }) => e.msg.toLowerCase().includes('heartbeat')),
    ).toBe(true);
  });

  it('returns empty entries array when q= matches nothing', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?q=xyzzy_no_match_ever',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().entries).toHaveLength(0);
  });

  it('rejects q longer than 120 chars with 400', async () => {
    const cookie = await loginAsOwner(h);
    const longQ = 'a'.repeat(121);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/logs?q=${longQ}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(400);
  });
});

describe('GET /api/v1/logs/export', () => {
  it('Owner downloads a gzipped export bundle', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs/export',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers['content-encoding']).toBe('gzip');
    expect(resp.headers['content-type']).toContain('text/plain');
    expect(resp.headers['content-disposition']).toMatch(/^attachment; filename="panel-logs-/);
    expect(resp.rawPayload.length).toBeGreaterThan(0);
  });

  it('returns 401 when unauthenticated', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/logs/export' });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for a caller without host:metrics (Viewer permissions)', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs/export',
      headers: await narrowedOwnerHeaders(h, VIEWER_PERMISSIONS),
    });
    expect(resp.statusCode).toBe(403);
  });

  it('filename contains an ISO timestamp', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs/export',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const disposition = resp.headers['content-disposition'] as string;
    expect(disposition).toMatch(/panel-logs-\d{4}-\d{2}-\d{2}/);
  });
});

describe('GET /api/v1/logs — sources and tail cursor', () => {
  async function append(fields: Record<string, string>): Promise<string> {
    const args: unknown[] = [PANEL_LOGS_STREAM, 'MAXLEN', '~', '10000', '*'];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    const id = await (h.redis as { xadd(...a: unknown[]): Promise<string | null> }).xadd(...args);
    if (!id) throw new Error('xadd returned no id');
    return id;
  }

  // #781: config-sync writes source code C; the route used to drop it from src=.
  it('filters by the config-sync source code (src=C)', async () => {
    await append(
      encodeLogEntry({ source: 'config-sync', level: 'info', msg: 'admins.cfg synced' }),
    );
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?src=C',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const entries = resp.json().entries as Array<{ source: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every((e) => e.source === 'config-sync')).toBe(true);
  });

  // #778/#779: the cursor must follow the scanned stream, not the filtered
  // result, or a filter that matches nothing in a window stalls the tail.
  it('returns a cursor that advances past entries the filter drops', async () => {
    const token = `cursor-probe-${Date.now()}`;
    const cookie = await loginAsOwner(h);
    const initial = await h.app.inject({
      method: 'GET',
      url: `/api/v1/logs?q=${token}`,
      headers: { cookie },
    });
    expect(initial.statusCode).toBe(200);
    const initialBody = initial.json() as { entries: unknown[]; cursor?: string };
    expect(initialBody.entries).toHaveLength(0);
    expect(initialBody.cursor).toMatch(/^\d+-\d+$/);

    for (let i = 0; i < 6; i += 1) {
      await append(encodeLogEntry({ source: 'api', level: 'info', msg: `filler ${i}` }));
    }
    const matchId = await append(
      encodeLogEntry({ source: 'api', level: 'error', msg: `found ${token}` }),
    );

    let cursor = initialBody.cursor as string;
    let found: Array<{ id: string }> = [];
    for (let poll = 0; poll < 20 && found.length === 0; poll += 1) {
      const resp = await h.app.inject({
        method: 'GET',
        url: `/api/v1/logs?q=${token}&limit=3&after=${cursor}`,
        headers: { cookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as { entries: Array<{ id: string }>; cursor: string };
      found = body.entries;
      if (found.length === 0) expect(body.cursor).not.toBe(cursor);
      cursor = body.cursor;
    }
    expect(found.map((e) => e.id)).toEqual([matchId]);
  });
});
