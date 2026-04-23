import {
  auditLog,
  playerIpHistory,
  playerNameHistory,
  players,
  userRoleAssignments,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './harness.js';

const EMAIL = 'owner@test.local';
const PASSWORD = 'correct-horse-battery-staple';

let h: IntegrationHarness;

afterEach(async () => {
  if (h) await h.cleanup();
});

async function login(harness = h): Promise<string> {
  const resp = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  if (resp.statusCode !== 200) throw new Error(`login failed: ${resp.body}`);
  const raw = Array.isArray(resp.headers['set-cookie'])
    ? resp.headers['set-cookie'][0]!
    : (resp.headers['set-cookie'] as string);
  return raw.match(/(__Host-sid=[^;]+)/)?.[1]!;
}

describe('GET /api/v1/players + /players/:steamId', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { email: EMAIL, password: PASSWORD },
      bridge: makeFakeBridge(),
    });
    const steamId = 76561198000000001n;
    await h.db.insert(players).values({
      steamId64: steamId,
      canonicalName: 'TestPlayer',
      canonicalNameNormalized: 'testplayer',
      eosId: 'eos-abc',
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-04-23T00:00:00Z'),
      totalTimePlayedSeconds: 3600n,
    });
    await h.db.insert(playerNameHistory).values({
      steamId64: steamId,
      name: 'TestPlayer',
      nameNormalized: 'testplayer',
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-04-23T00:00:00Z'),
      observationCount: 5,
    });
    await h.db.insert(playerIpHistory).values({
      steamId64: steamId,
      ip: '203.0.113.5',
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-04-23T00:00:00Z'),
    });
  });

  it('lists seeded players ordered by last_seen_at desc', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      items: Array<{ steam_id64: string; canonical_name: string }>;
      total: number;
    }>();
    expect(body.total).toBe(1);
    expect(body.items[0]?.steam_id64).toBe('76561198000000001');
    expect(body.items[0]?.canonical_name).toBe('TestPlayer');
  });

  it('detail view shows names and ips for Owner (has player:view_ips)', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/76561198000000001',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      names: Array<{ name: string }>;
      ips: Array<{ ip: string }>;
      ips_visible: boolean;
    }>();
    expect(body.ips_visible).toBe(true);
    expect(body.names).toHaveLength(1);
    expect(body.ips).toHaveLength(1);
    expect(body.ips[0]?.ip).toBe('203.0.113.5');
  });

  it('detail view hides IPs from a user without player:view_ips', async () => {
    // Demote the owner to Viewer (no view_ips).
    const viewerRole = await h.db.query.roles.findFirst({
      where: (r, { and: _a, eq: _e }) => _a(_e(r.orgId, h.seed.orgId!), _e(r.name, 'Viewer')),
    });
    if (!viewerRole || !h.seed.ownerUserId) throw new Error('viewer role missing');
    await h.db
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, h.seed.ownerUserId));
    await h.db.insert(userRoleAssignments).values({
      userId: h.seed.ownerUserId,
      roleId: viewerRole.id,
    });
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/76561198000000001',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ ips: unknown[]; ips_visible: boolean }>();
    expect(body.ips_visible).toBe(false);
    expect(body.ips).toEqual([]);
  });

  it('returns 404 for unknown steamId', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/76561198000000999',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });
});

describe('/api/v1/depot', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { email: EMAIL, password: PASSWORD },
      bridge: makeFakeBridge(),
    });
  });

  it('GET /depot reports populated=true when fake bridge returns the marker file', async () => {
    h.bridge.fileRead = async ({ path }) =>
      path.endsWith('SquadGameServer.sh')
        ? { content: '#!/bin/sh' }
        : path.endsWith('appmanifest_403240.acf')
          ? { content: '"AppState"\n{\n\t"buildid"\t"1234567"\n}' }
          : Promise.reject(new Error('ENOENT'));
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ populated: boolean; build_id: string | null }>();
    expect(body.populated).toBe(true);
    expect(body.build_id).toBe('1234567');
  });

  it('POST /depot/update returns already_in_progress when a lock exists', async () => {
    const cookie = await login();
    const startedAt = new Date().toISOString();
    await h.redis.set('depot:updating', startedAt, 'EX', 60);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ status: string; since: string }>();
    expect(body.status).toBe('already_in_progress');
    expect(body.since).toBe(startedAt);
    await h.redis.del('depot:updating');
  });
});

describe('auth plugin', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { email: EMAIL, password: PASSWORD },
      bridge: makeFakeBridge(),
    });
  });

  it('a garbage cookie does not crash the server and falls through to 401', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: '__Host-sid=not-a-real-session' },
    });
    expect(resp.statusCode).toBe(401);
  });

  it('protected route enforces permissions: Viewer is 403 on POST /servers', async () => {
    const viewerRole = await h.db.query.roles.findFirst({
      where: (r, { and: _a, eq: _e }) => _a(_e(r.orgId, h.seed.orgId!), _e(r.name, 'Viewer')),
    });
    if (!viewerRole || !h.seed.ownerUserId) throw new Error('viewer role missing');
    await h.db
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, h.seed.ownerUserId));
    await h.db
      .insert(userRoleAssignments)
      .values({ userId: h.seed.ownerUserId, roleId: viewerRole.id });
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        display_name: 'X',
        slug: 'x',
        game_port: 7787,
        query_port: 27165,
        beacon_port: 15000,
        rcon_port: 21114,
      },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: string; required: string[] }>().required).toContain('server:create');
  });
});

describe('audit plugin', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { email: EMAIL, password: PASSWORD },
      bridge: makeFakeBridge(),
    });
  });

  it('does not write audit rows for routes with audit: false', async () => {
    const cookie = await login();
    const before = await h.db.select().from(auditLog);
    const loginCount = before.filter((r) => r.actionType === 'user.login').length;
    // Hit a bunch of audit:false endpoints.
    await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    await h.app.inject({ method: 'GET', url: '/api/v1/host/info', headers: { cookie } });
    await h.app.inject({ method: 'GET', url: '/api/v1/host/metrics', headers: { cookie } });
    await h.app.inject({ method: 'GET', url: '/api/v1/permissions', headers: { cookie } });
    // Give the onResponse hook a tick — though for audit:false nothing should be
    // written even if it fired.
    await new Promise((r) => setTimeout(r, 100));
    const after = await h.db.select().from(auditLog);
    expect(after.length).toBe(before.length);
    expect(loginCount).toBeGreaterThanOrEqual(1);
  });

  it('writes an audit row even when the request returns 4xx', async () => {
    // An unauthenticated POST /auth/logout still runs through audit
    // onResponse; the user is null, the action is user.logout.
    await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    // Wait briefly for async hook.
    await new Promise((r) => setTimeout(r, 150));
    const rows = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actionType, 'user.logout'), eq(auditLog.actorKind, 'system')));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await assertAuditRow(h, { action: 'user.logout' });
  });
});
