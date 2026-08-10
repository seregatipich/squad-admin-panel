import {
  auditLog,
  playerIpHistory,
  playerNameHistory,
  players,
  roles,
  serverSettings,
  servers,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000000999n;

let h: IntegrationHarness;

afterEach(async () => {
  if (h) await h.cleanup();
});

describe('GET /api/v1/players + /players/:playerId', () => {
  let testPlayerId: string;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
      bridge: makeFakeBridge(),
    });
    const steamId = 76561198000000001n;
    const [insertedPlayer] = await h.db
      .insert(players)
      .values({
        steamId64: steamId,
        canonicalName: 'TestPlayer',
        canonicalNameNormalized: 'testplayer',
        eosId: 'eos-abc',
        firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: new Date('2026-04-23T00:00:00Z'),
        totalTimePlayedSeconds: 3600,
      })
      .returning({ id: players.id });
    if (!insertedPlayer) throw new Error('failed to seed test player');
    testPlayerId = insertedPlayer.id;
    await h.db.insert(playerNameHistory).values({
      playerId: testPlayerId,
      name: 'TestPlayer',
      nameNormalized: 'testplayer',
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-04-23T00:00:00Z'),
      observationCount: 5,
    });
    await h.db.insert(playerIpHistory).values([
      {
        playerId: testPlayerId,
        ip: '203.0.113.5',
        countryCode: 'DE',
        countryName: 'Germany',
        region: 'Berlin',
        city: 'Berlin',
        timezoneOffset: 'Europe/Berlin',
        latitude: 52.52,
        longitude: 13.405,
        observationCount: 3,
        firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: new Date('2026-04-23T00:00:00Z'),
      },
      {
        playerId: testPlayerId,
        ip: '198.51.100.9',
        firstSeenAt: new Date('2026-02-01T00:00:00Z'),
        lastSeenAt: new Date('2026-03-01T00:00:00Z'),
      },
    ]);
  });

  it('lists seeded players ordered by last_seen_at desc', async () => {
    const cookie = await loginAsOwner(h);
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
    expect(body.total).toBeGreaterThanOrEqual(1);
    const player = body.items.find((i) => i.steam_id64 === '76561198000000001');
    expect(player?.canonical_name).toBe('TestPlayer');
  });

  it('detail view shows names, ips + frozen geo for a panel_access user (Owner)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${testPlayerId}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      names: Array<{ name: string }>;
      ips: Array<{
        ip: string;
        country_code: string | null;
        city: string | null;
        timezone_offset: string | null;
        observation_count: number;
      }>;
      locations: Array<{ country_code: string; country_name: string | null }>;
      ips_visible: boolean;
      geo_configured: boolean;
    }>();
    expect(body.ips_visible).toBe(true);
    expect(body.names).toHaveLength(1);
    expect(body.ips).toHaveLength(2);
    const geoIp = body.ips.find((i) => i.ip === '203.0.113.5');
    expect(geoIp?.country_code).toBe('DE');
    expect(geoIp?.city).toBe('Berlin');
    expect(geoIp?.timezone_offset).toBe('Europe/Berlin');
    expect(geoIp?.observation_count).toBe(3);
    const nullGeoIp = body.ips.find((i) => i.ip === '198.51.100.9');
    expect(nullGeoIp?.country_code).toBeNull();
    expect(body.locations).toEqual([
      { country_code: 'DE', country_name: 'Germany', last_seen_at: expect.anything() },
    ]);
    expect(body.geo_configured).toBe(false);
  });

  it('detail view hides IPs from a non-panel_access user but still shows country-only locations', async () => {
    const viewerRoleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRoleRows[0]?.id;
    if (!viewerRoleId || !h.seed.ownerSteamId64) throw new Error('viewer role missing');
    await h.db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    if (!h.seed.ownerPlayerId) throw new Error('seed owner missing');
    invalidatePermissionCache(h.seed.ownerPlayerId);
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${testPlayerId}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      ips: unknown[];
      ips_visible: boolean;
      locations: Array<{ country_code: string; country_name: string | null }>;
    }>();
    expect(body.ips_visible).toBe(false);
    expect(body.ips).toEqual([]);
    expect(body.locations).toEqual([
      { country_code: 'DE', country_name: 'Germany', last_seen_at: expect.anything() },
    ]);
  });

  it('returns 404 for unknown playerId', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/00000000-0000-7000-8000-000000000998',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });
});

describe('/api/v1/depot', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
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
    const cookie = await loginAsOwner(h);
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
    const cookie = await loginAsOwner(h);
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

  // Regression (Wave 11 clarification of #45 / SRV-6, depot workflow #44):
  // the dashboard modal used to POST the operator's server-stop selection under
  // the wrong key `stop_server_ids`. The non-strict body schema silently dropped
  // it, `server_ids` defaulted to [], and the depot was rewritten while those
  // servers were still running. The body schema is now `.strict()`, so the old
  // mismatched payload is rejected loudly instead of being a silent no-op.
  it('POST /depot/update rejects the legacy stop_server_ids body with 400', async () => {
    await h.redis.del('depot:updating');
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { stop_server_ids: [uuidv7()] },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json<{ error: string }>().error).toBe('validation_error');
    // The unknown key must not have silently acquired the update lock.
    expect(await h.redis.get('depot:updating')).toBeNull();
  });

  it('POST /depot/update accepts the correct server_ids key for a running server', async () => {
    await h.redis.del('depot:updating');
    const serverId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Depot Test Server',
      slug: `depot-${serverId.slice(0, 8)}`,
      status: 'running',
      runtime: 'container',
    });
    await h.db.insert(serverSettings).values({
      serverId,
      installPath: `/var/lib/squad-panel/configs/${serverId}`,
      gamePort: 7787,
      queryPort: 27165,
      beaconPort: 15000,
      rconPort: 21114,
    });

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [serverId] },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ status: string; servers_to_stop: string[] }>();
    expect(body.status).toBe('started');
    expect(body.servers_to_stop).toEqual([serverId]);

    // Let the fire-and-forget orchestration settle against the fake bridge so it
    // does not race the harness teardown, then clear the lock it acquired.
    await new Promise((r) => setTimeout(r, 200));
    await h.redis.del('depot:updating');
  });

  it('POST /depot/update rejects a non-existent server_id with servers_not_found', async () => {
    await h.redis.del('depot:updating');
    const cookie = await loginAsOwner(h);
    const bogus = uuidv7();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [bogus] },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: string; missing: string[] }>();
    expect(body.error).toBe('servers_not_found');
    expect(body.missing).toEqual([bogus]);
    expect(await h.redis.get('depot:updating')).toBeNull();
  });
});

describe('auth plugin', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
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
    const viewerRoleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRoleRows[0]?.id;
    if (!viewerRoleId || !h.seed.ownerSteamId64) throw new Error('viewer role missing');
    await h.db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    if (!h.seed.ownerPlayerId) throw new Error('seed owner missing');
    invalidatePermissionCache(h.seed.ownerPlayerId);
    const cookie = await loginAsOwner(h);
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
    expect(resp.json<{ error: string; required: string[] }>().required).toContain('server:install');
  });
});

describe('audit plugin', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
      bridge: makeFakeBridge(),
    });
  });

  it('does not write audit rows for routes with audit: false', async () => {
    const cookie = await loginAsOwner(h);
    const before = await h.db.select().from(auditLog);
    await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    await h.app.inject({ method: 'GET', url: '/api/v1/host/info', headers: { cookie } });
    await h.app.inject({ method: 'GET', url: '/api/v1/host/metrics', headers: { cookie } });
    await h.app.inject({ method: 'GET', url: '/api/v1/permissions', headers: { cookie } });
    await new Promise((r) => setTimeout(r, 100));
    const after = await h.db.select().from(auditLog);
    expect(after.length).toBe(before.length);
  });

  it('writes an audit row even when the request returns 4xx', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    await new Promise((r) => setTimeout(r, 150));
    const rows = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actionType, 'user.logout'), eq(auditLog.actorKind, 'system')));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await assertAuditRow(h, { action: 'user.logout' });
  });
});
