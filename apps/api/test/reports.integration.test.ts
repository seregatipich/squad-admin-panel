import { playerReports, players, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import type { LiveEvent } from '../src/plugins/live-bus.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM = testSteamId(950101);
const HANDLER_STEAM = testSteamId(950102);
const PANEL_ONLY_STEAM = testSteamId(950103);
const NO_PANEL_STEAM = testSteamId(950104);
const REPORTER_STEAM = testSteamId(950111);
const TARGET_STEAM = testSteamId(950112);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let serverAId: string;
let serverBId: string;
let reporterId: string;
let targetId: string;

let reportPending: string;
let reportInReview: string;
let reportResolvedNoTarget: string;
let reportRejected: string;

async function seedPlayer(steamId64: bigint, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({ steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase() })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedServer(name: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({ id, displayName: name, slug: `${name}-${id}` });
  return id;
}

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  panelAccess: boolean;
  canHandleReports: boolean;
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canHandleReports: opts.canHandleReports,
  });
  const stub = `Player${String(opts.steamId64).slice(-4)}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: stub,
      canonicalNameNormalized: stub.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player for ${opts.roleName}`);
  return row.id;
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player found for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'reports-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });

  await seedRoleWithPlayer({
    roleName: `ReportHandler-${Date.now()}`,
    steamId64: HANDLER_STEAM,
    panelAccess: true,
    canHandleReports: true,
  });
  await seedRoleWithPlayer({
    roleName: `PanelOnly-${Date.now()}`,
    steamId64: PANEL_ONLY_STEAM,
    panelAccess: true,
    canHandleReports: false,
  });
  await seedRoleWithPlayer({
    roleName: `NoPanel-${Date.now()}`,
    steamId64: NO_PANEL_STEAM,
    panelAccess: false,
    canHandleReports: false,
  });

  reporterId = await seedPlayer(REPORTER_STEAM, 'ReporterPlayer');
  targetId = await seedPlayer(TARGET_STEAM, 'TargetPlayer');
  serverAId = await seedServer('report-test-server-a');
  serverBId = await seedServer('report-test-server-b');

  const now = Date.now();
  const rows = await h.db
    .insert(playerReports)
    .values([
      {
        serverId: serverAId,
        reporterPlayerId: reporterId,
        targetPlayerId: targetId,
        body: 'Player is teamkilling on purpose',
        source: 'ingame',
        status: 'pending',
        createdAt: new Date(now),
      },
      {
        serverId: serverBId,
        reporterPlayerId: targetId,
        targetPlayerId: reporterId,
        body: 'Suspected of using an aimbot',
        source: 'ui',
        status: 'in_review',
        createdAt: new Date(now - 60 * 60 * 1000),
      },
      {
        serverId: serverAId,
        reporterPlayerId: reporterId,
        targetPlayerId: null,
        targetRaw: 'UnregisteredGuy123',
        body: 'Spamming chat with links',
        source: 'ingame',
        status: 'resolved',
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
      },
      {
        serverId: serverAId,
        reporterPlayerId: null,
        targetPlayerId: targetId,
        body: 'False report from an anonymous source',
        source: 'ui',
        status: 'rejected',
        createdAt: new Date(now - 3 * 60 * 60 * 1000),
      },
    ])
    .returning({ id: playerReports.id, status: playerReports.status });

  function idFor(status: string): string {
    const found = rows.find((r) => r.status === status);
    if (!found) throw new Error(`seed failed: no report row with status=${status}`);
    return found.id;
  }
  reportPending = idFor('pending');
  reportInReview = idFor('in_review');
  reportResolvedNoTarget = idFor('resolved');
  reportRejected = idFor('rejected');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/reports', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/reports' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects panel access without panelAccess', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports',
      headers: { cookie: await loginAsSteam(NO_PANEL_STEAM) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists all reports sorted by created_at desc', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports?page_size=100',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; created_at: string }>; total: number };
    const ids = body.items.map((r) => r.id);
    expect(ids).toEqual([reportPending, reportInReview, reportResolvedNoTarget, reportRejected]);
    expect(body.total).toBeGreaterThanOrEqual(4);
  });

  it('filters by status', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports?status=pending&page_size=100',
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { items: Array<{ id: string; status: string }> };
    expect(body.items.map((r) => r.id)).toEqual([reportPending]);
    expect(body.items.every((r) => r.status === 'pending')).toBe(true);
  });

  it('filters by server_id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports?server_id=${serverBId}&page_size=100`,
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((r) => r.id)).toEqual([reportInReview]);
  });

  it('filters by target_player_id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports?target_player_id=${targetId}&page_size=100`,
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((r) => r.id).sort()).toEqual([reportPending, reportRejected].sort());
  });

  it('filters by reporter_player_id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports?reporter_player_id=${reporterId}&page_size=100`,
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((r) => r.id).sort()).toEqual(
      [reportPending, reportResolvedNoTarget].sort(),
    );
  });

  it('filters by q (ilike on body)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports?q=aimbot&page_size=100',
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((r) => r.id)).toEqual([reportInReview]);
  });

  it('filters by created_from/created_to range', async () => {
    const from = new Date(Date.now() - 150 * 60 * 1000).toISOString();
    const to = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports?created_from=${encodeURIComponent(from)}&created_to=${encodeURIComponent(to)}&page_size=100`,
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((r) => r.id).sort()).toEqual(
      [reportInReview, reportResolvedNoTarget].sort(),
    );
  });

  it('paginates with page/page_size', async () => {
    const first = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports?page=1&page_size=2',
      headers: { cookie: await loginAsOwner(h) },
    });
    const firstBody = first.json() as { items: Array<{ id: string }>; total: number };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.items.map((r) => r.id)).toEqual([reportPending, reportInReview]);

    const second = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports?page=2&page_size=2',
      headers: { cookie: await loginAsOwner(h) },
    });
    const secondBody = second.json() as { items: Array<{ id: string }> };
    expect(secondBody.items.map((r) => r.id)).toEqual([reportResolvedNoTarget, reportRejected]);
  });
});

describeIfDb('GET /api/v1/reports/:id', () => {
  it('returns a single report with resolved player names', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportPending}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      reporter_name: string | null;
      target_name: string | null;
      server_id: string;
    };
    expect(body.id).toBe(reportPending);
    expect(body.reporter_name).toBe('ReporterPlayer');
    expect(body.target_name).toBe('TargetPlayer');
    expect(body.server_id).toBe(serverAId);
  });

  it('returns target_raw when the target has no linked player', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportResolvedNoTarget}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { target_player_id: string | null; target_raw: string | null };
    expect(body.target_player_id).toBeNull();
    expect(body.target_raw).toBe('UnregisteredGuy123');
  });

  it('404s for an unknown id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports/00000000-0000-0000-0000-000000000000',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describeIfDb('PATCH /api/v1/reports/:id', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportPending}`,
      payload: { status: 'in_review' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without can_handle_reports', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportPending}`,
      headers: { cookie: await loginAsSteam(PANEL_ONLY_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'in_review' }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string; required: string }).required).toBe('can_handle_reports');
  });

  it('rejects an empty body', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportPending}`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for an unknown id', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/reports/00000000-0000-0000-0000-000000000000',
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'in_review' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('claims a pending report, writes an audit row, and publishes report.updated', async () => {
    const received: LiveEvent[] = [];
    const unsub = h.app.liveBus.subscribe((event) => received.push(event));
    try {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/reports/${reportPending}`,
        headers: {
          cookie: await loginAsSteam(HANDLER_STEAM),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ status: 'in_review', resolution_note: 'Looking into it' }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        status: string;
        handler_player_id: string | null;
        resolution_note: string | null;
        claimed_at: string | null;
      };
      expect(body.status).toBe('in_review');
      expect(body.resolution_note).toBe('Looking into it');
      expect(body.handler_player_id).not.toBeNull();
      expect(body.claimed_at).not.toBeNull();

      await assertAuditRow(h, {
        action: 'report.update',
        resource: 'report',
        targetId: reportPending,
      });

      const updatedEvt = received.find(
        (e) => e.type === 'report.updated' && e.data.report.id === reportPending,
      );
      expect(updatedEvt).toBeDefined();
      if (updatedEvt && updatedEvt.type === 'report.updated') {
        expect(updatedEvt.data.report.status).toBe('in_review');
      }
    } finally {
      unsub();
    }
  });

  it('resolves a report and stamps resolved_at', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportPending}`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'resolved' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; resolved_at: string | null };
    expect(body.status).toBe('resolved');
    expect(body.resolved_at).not.toBeNull();
  });

  it('Owner can handle reports without an explicit can_handle_reports flag on their row', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportRejected}`,
      headers: { cookie: await loginAsOwner(h), 'content-type': 'application/json' },
      payload: JSON.stringify({ resolution_note: 'reviewed by owner' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resolution_note: string | null };
    expect(body.resolution_note).toBe('reviewed by owner');
  });
});
