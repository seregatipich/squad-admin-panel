import { externalBanSources, externalBans, players, roles } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches, loadUserPermissions } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(941001);
const MANAGER_STEAM = testSteamId(941002);
const VIEWER_STEAM = testSteamId(941003);

let h: IntegrationHarness;
let managerCookie: string;
let viewerCookie: string;
let ownerCookie: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint, userAgent: string): Promise<string> {
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
    userAgent,
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  canManageBanSources: boolean;
}): Promise<void> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: true,
    canManageBanSources: opts.canManageBanSources,
  });
  const stub = `Player${String(opts.steamId64).slice(-4)}`;
  await h.db.insert(players).values({
    steamId64: opts.steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  await seedRoleWithPlayer({
    roleName: 'BanSourceManager',
    steamId64: MANAGER_STEAM,
    canManageBanSources: true,
  });
  await seedRoleWithPlayer({
    roleName: 'BanSourceViewer',
    steamId64: VIEWER_STEAM,
    canManageBanSources: false,
  });
  ownerCookie = await loginAsOwner(h);
  managerCookie = await loginAsSteam(MANAGER_STEAM, 'ban-sources-manager');
  viewerCookie = await loginAsSteam(VIEWER_STEAM, 'ban-sources-viewer');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

async function createSource(
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/ban-sources',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: `RuBans-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      url: 'https://collabans.example.com/bans.cfg',
      format: 'squad_bans_cfg',
      trust_level: 'trusted',
      discord_url: 'https://discord.gg/example',
      auth_header: 'Bearer super-secret-token-xyz',
      enabled: true,
      poll_interval_minutes: 30,
      ...overrides,
    }),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describeIfDb('ban-sources RBAC (can_manage_ban_sources)', () => {
  it('rejects unauthenticated create with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ban-sources',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'nope',
        url: 'https://example.com/bans.cfg',
        format: 'csv',
      }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects create for a panel user without can_manage_ban_sources (403)', async () => {
    const { statusCode, body } = await createSource(viewerCookie);
    expect(statusCode).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.required).toBe('can_manage_ban_sources');
  });

  it('allows a manager with can_manage_ban_sources to create (201)', async () => {
    const { statusCode, body } = await createSource(managerCookie);
    expect(statusCode).toBe(201);
    expect(body.name).toContain('RuBans-');
    expect(body.trust_level).toBe('trusted');
    expect(body.enabled).toBe(true);
    expect(body.poll_interval_minutes).toBe(30);
    expect(body.on_match).toBe('alert');
  });

  it('rejects kick for a non-trusted source with 422', async () => {
    const { statusCode, body } = await createSource(managerCookie, {
      trust_level: 'normal',
      on_match: 'kick',
    });
    expect(statusCode).toBe(422);
    expect(body).toEqual({ error: 'kick_requires_trusted_source' });
  });

  it('allows kick only for a trusted source and rejects a later trust downgrade', async () => {
    const { statusCode, body } = await createSource(managerCookie, { on_match: 'kick' });
    expect(statusCode).toBe(201);
    expect(body.on_match).toBe('kick');
    const id = body.id as string;

    const downgrade = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ trust_level: 'normal' }),
    });
    expect(downgrade.statusCode).toBe(422);
    expect(downgrade.json()).toEqual({ error: 'kick_requires_trusted_source' });
  });

  it('allows the Owner to create (201)', async () => {
    const { statusCode } = await createSource(ownerCookie);
    expect(statusCode).toBe(201);
  });

  it('rejects update and delete and sync for a user without the flag (403)', async () => {
    const { body } = await createSource(managerCookie);
    const id = body.id as string;
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(put.statusCode).toBe(403);
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: viewerCookie },
    });
    expect(del.statusCode).toBe(403);
    const sync = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ban-sources/${id}/sync`,
      headers: { cookie: viewerCookie },
    });
    expect(sync.statusCode).toBe(403);
  });
});

describeIfDb('ban-sources reading = panel_access', () => {
  it('lets a panel user without the manage flag read the aggregate list', async () => {
    await createSource(managerCookie);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ban-sources',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
  });

  it('rejects unauthenticated read with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/ban-sources' });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('auth_header is never returned by the API', () => {
  it('omits auth_header from create response and exposes has_auth_header only', async () => {
    const { body } = await createSource(managerCookie);
    expect(body).not.toHaveProperty('auth_header');
    expect(body).not.toHaveProperty('auth_header_encrypted');
    expect(body.has_auth_header).toBe(true);
  });

  it('omits auth_header from list and single-get responses', async () => {
    const { body } = await createSource(managerCookie);
    const id = body.id as string;
    const single = await h.app.inject({
      method: 'GET',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie },
    });
    const singleBody = single.json() as Record<string, unknown>;
    expect(singleBody).not.toHaveProperty('auth_header');
    expect(singleBody.has_auth_header).toBe(true);

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ban-sources',
      headers: { cookie: managerCookie },
    });
    for (const item of list.json() as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('auth_header');
    }
  });

  it('stores the auth header encrypted at rest, not as plaintext', async () => {
    const { body } = await createSource(managerCookie);
    const id = body.id as string;
    const [row] = await h.db
      .select({ blob: externalBanSources.authHeaderEncrypted })
      .from(externalBanSources)
      .where(eq(externalBanSources.id, id))
      .limit(1);
    expect(row?.blob).toBeInstanceOf(Buffer);
    const asText = (row?.blob as Buffer).toString('utf-8');
    expect(asText).not.toContain('super-secret-token-xyz');
    expect(asText).toContain('"v":1');
  });

  it('creating without an auth header sets has_auth_header=false', async () => {
    const { statusCode, body } = await createSource(managerCookie, { auth_header: null });
    expect(statusCode).toBe(201);
    expect(body.has_auth_header).toBe(false);
  });
});

describeIfDb('ban-sources update / disable / sync', () => {
  it('disables a source via PUT enabled=false', async () => {
    const { body } = await createSource(managerCookie);
    const id = body.id as string;
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).enabled).toBe(false);
  });

  it('sync enqueues a job onto the bansync:manual stream and returns {ok:true, queued:true}', async () => {
    const { body } = await createSource(managerCookie);
    const id = body.id as string;
    const before = await h.redis.xlen('bansync:manual');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ban-sources/${id}/sync`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: true });

    const after = await h.redis.xlen('bansync:manual');
    expect(after).toBe(before + 1);

    const entries = await h.redis.xrevrange('bansync:manual', '+', '-', 'COUNT', 1);
    const [, fields] = entries[0] as [string, string[]];
    const jobIdx = fields.indexOf('job');
    expect(jobIdx).toBeGreaterThanOrEqual(0);
    const job = JSON.parse(fields[jobIdx + 1] as string) as Record<string, unknown>;
    expect(job.source_id).toBe(id);
    expect(job).toHaveProperty('request_id');
    expect(job).toHaveProperty('enqueued_at');
  });

  it('returns 404 when syncing a missing source without enqueueing a job', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const before = await h.redis.xlen('bansync:manual');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ban-sources/${missing}/sync`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(404);
    const after = await h.redis.xlen('bansync:manual');
    expect(after).toBe(before);
  });

  it('accepts parser_config on create and round-trips it through GET and PUT', async () => {
    const { statusCode, body } = await createSource(managerCookie, {
      parser_config: { list_path: 'data', fields: { steam_id64: 'attributes.steamId' } },
    });
    expect(statusCode).toBe(201);
    expect(body.parser_config).toEqual({
      list_path: 'data',
      fields: { steam_id64: 'attributes.steamId' },
    });
    const id = body.id as string;

    const got = await h.app.inject({
      method: 'GET',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie },
    });
    expect((got.json() as Record<string, unknown>).parser_config).toEqual({
      list_path: 'data',
      fields: { steam_id64: 'attributes.steamId' },
    });

    const updated = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ parser_config: { csv: { delimiter: ';' } } }),
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as Record<string, unknown>).parser_config).toEqual({
      csv: { delimiter: ';' },
    });
  });

  it('returns 404 for update/sync of a missing source', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${missing}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(put.statusCode).toBe(404);
  });
});

describeIfDb('ban-sources mutations are audited', () => {
  it('writes ban_source.create / update / sync / delete audit rows', async () => {
    const { body } = await createSource(managerCookie);
    const id = body.id as string;
    await assertAuditRow(h, { action: 'ban_source.create', resource: 'ban_source', targetId: id });

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ trust_level: 'low' }),
    });
    await assertAuditRow(h, { action: 'ban_source.update', resource: 'ban_source', targetId: id });

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/ban-sources/${id}/sync`,
      headers: { cookie: managerCookie },
    });
    await assertAuditRow(h, { action: 'ban_source.sync', resource: 'ban_source', targetId: id });

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie },
    });
    await assertAuditRow(h, { action: 'ban_source.delete', resource: 'ban_source', targetId: id });
  });
});

// Audit #100 — the ban-sync worker fetches the stored URL unattended, so it
// must not point into the panel's own network.
describeIfDb('ban-source URLs cannot target internal addresses', () => {
  it.each([
    'http://redis:6379/',
    'http://postgres:5432/',
    'http://127.0.0.1:3000/api/v1/me',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.8/bans.cfg',
    'http://[::1]/bans.cfg',
    'http://localhost/bans.cfg',
    'ftp://collabans.example.com/bans.cfg',
  ])('rejects creating a source at %s with 400', async (url) => {
    const res = await createSource(managerCookie, { url });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('url_not_allowed');
  });

  it('rejects moving an existing source to an internal address with 400', async () => {
    const { body } = await createSource(managerCookie);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${body.id as string}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    expect(res.statusCode).toBe(400);
    const [row] = await h.db
      .select({ url: externalBanSources.url })
      .from(externalBanSources)
      .where(eq(externalBanSources.id, body.id as string));
    expect(row?.url).toBe('https://collabans.example.com/bans.cfg');
  });
});

// Audit #102 — the routes used to write their entry by hand on the success
// path only; the declarative hook records every outcome.
describeIfDb('ban-sources audit covers denied and rejected attempts', () => {
  it('records a 403 create by a user without can_manage_ban_sources', async () => {
    const res = await createSource(viewerCookie);
    expect(res.statusCode).toBe(403);
    const row = await assertAuditRow(h, {
      action: 'ban_source.create',
      resource: 'ban_source',
      statusCode: 403,
    });
    expect(row.statusCode).toBe(403);
  });

  it('records a 422 kick_requires_trusted_source create', async () => {
    const res = await createSource(managerCookie, { trust_level: 'normal', on_match: 'kick' });
    expect(res.statusCode).toBe(422);
    const row = await assertAuditRow(h, {
      action: 'ban_source.create',
      resource: 'ban_source',
      statusCode: 422,
    });
    expect(row.statusCode).toBe(422);
  });

  it('records a 404 delete of a missing source', async () => {
    const missingId = uuidv7();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/ban-sources/${missingId}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(404);
    const row = await assertAuditRow(h, {
      action: 'ban_source.delete',
      resource: 'ban_source',
      targetId: missingId,
      statusCode: 404,
    });
    expect(row.statusCode).toBe(404);
  });

  it('keeps before/after snapshots on a successful update', async () => {
    const { body } = await createSource(managerCookie, { trust_level: 'trusted' });
    const id = body.id as string;
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ trust_level: 'low' }),
    });
    expect(res.statusCode).toBe(200);
    const row = await assertAuditRow(h, {
      action: 'ban_source.update',
      resource: 'ban_source',
      targetId: id,
      statusCode: 200,
    });
    expect(row.statusCode).toBe(200);
    expect(row.beforeSnapshot).toMatchObject({ trust_level: 'trusted', has_auth_header: true });
    expect(row.afterSnapshot).toMatchObject({ trust_level: 'low', has_auth_header: true });
    expect(JSON.stringify(row.afterSnapshot)).not.toContain('super-secret-token-xyz');
  });
});

describeIfDb('ban-sources input and exposure hardening (#103, #104, #107, #112)', () => {
  it('rejects a non-https discord_url on create and update (#104)', async () => {
    for (const discordUrl of ['javascript:alert(1)', 'data:text/html,x', 'http://discord.gg/x']) {
      const { statusCode } = await createSource(managerCookie, { discord_url: discordUrl });
      expect(statusCode).toBe(400);
    }
    const { body } = await createSource(managerCookie);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${body.id as string}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ discord_url: 'file:///etc/passwd' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a feed URL that embeds credentials (#103)', async () => {
    const { statusCode } = await createSource(managerCookie, {
      url: 'https://user:hunter2@collabans.example.com/bans.cfg',
    });
    expect(statusCode).toBe(400);
  });

  it('masks query values of the feed URL in responses and audit snapshots (#103)', async () => {
    const { statusCode, body } = await createSource(managerCookie, {
      url: 'https://api.example.com/bans?key=s3cr3t-api-key&format=json',
    });
    expect(statusCode).toBe(201);
    const id = body.id as string;
    expect(body.url).toBe('https://api.example.com/bans?key=***&format=***');

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ban-sources',
      headers: { cookie: viewerCookie },
    });
    expect(list.body).not.toContain('s3cr3t-api-key');

    const audit = await assertAuditRow(h, {
      action: 'ban_source.create',
      resource: 'ban_source',
      targetId: id,
    });
    expect(JSON.stringify(audit.afterSnapshot)).not.toContain('s3cr3t-api-key');

    // Echoing the masked URL back (GET → PUT round-trip) keeps the stored secret.
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: body.url, enabled: false }),
    });
    const [stored] = await h.db
      .select({ url: externalBanSources.url })
      .from(externalBanSources)
      .where(eq(externalBanSources.id, id));
    expect(stored?.url).toBe('https://api.example.com/bans?key=s3cr3t-api-key&format=json');
  });

  it('counts only active (not revoked) records (#107)', async () => {
    const { body } = await createSource(managerCookie);
    const sourceId = body.id as string;
    await h.db.insert(externalBans).values([
      { sourceId, steamId64: '76561198000000011' },
      { sourceId, steamId64: '76561198000000012', revokedAt: new Date() },
    ]);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ban-sources',
      headers: { cookie: viewerCookie },
    });
    const source = (res.json() as Array<{ id: string; record_count: number }>).find(
      (entry) => entry.id === sourceId,
    );
    expect(source?.record_count).toBe(1);
    const single = await h.app.inject({
      method: 'GET',
      url: `/api/v1/ban-sources/${sourceId}`,
      headers: { cookie: viewerCookie },
    });
    expect((single.json() as { record_count: number }).record_count).toBe(1);
  });

  it('refuses a second manual sync while one is still queued (#112)', async () => {
    const { body } = await createSource(managerCookie);
    const id = body.id as string;
    const before = await h.redis.xlen('bansync:manual');
    const sync = () =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/ban-sources/${id}/sync`,
        headers: { cookie: managerCookie },
      });
    expect((await sync()).statusCode).toBe(200);
    const again = await sync();
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'sync_already_queued' });
    expect(await h.redis.xlen('bansync:manual')).toBe(before + 1);
  });

  it('backs the active record count with a partial index (#107)', async () => {
    const rows = await h.db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'external_bans_active_source_idx'
    `);
    expect(rows[0]?.indexdef).toContain('WHERE (revoked_at IS NULL)');
  });
});

describeIfDb('external_bans dedup unique index', () => {
  it('re-importing the same record does not create a duplicate', async () => {
    const { body } = await createSource(managerCookie);
    const sourceId = body.id as string;
    const record = {
      sourceId,
      steamId64: '76561198000000001',
      eosId: null,
      nickname: 'Cheater',
      reason: 'aimbot',
      issuedAt: null,
    };
    await h.db.insert(externalBans).values(record).onConflictDoNothing();
    await h.db.insert(externalBans).values(record).onConflictDoNothing();
    const rows = await h.db
      .select({ id: externalBans.id })
      .from(externalBans)
      .where(eq(externalBans.sourceId, sourceId));
    expect(rows.length).toBe(1);

    await h.db
      .insert(externalBans)
      .values({ ...record, steamId64: '76561198000000002' })
      .onConflictDoNothing();
    const afterSecond = await h.db
      .select({ id: externalBans.id })
      .from(externalBans)
      .where(eq(externalBans.sourceId, sourceId));
    expect(afterSecond.length).toBe(2);
  });
});

describeIfDb('role editor surface exposes can_manage_ban_sources', () => {
  it('GET /api/v1/roles returns the flag; Owner has it true', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const rolesList = res.json() as Array<Record<string, unknown>>;
    const owner = rolesList.find((r) => r.name === 'Owner');
    expect(owner?.can_manage_ban_sources).toBe(true);
    const manager = rolesList.find((r) => r.name === 'BanSourceManager');
    expect(manager?.can_manage_ban_sources).toBe(true);
    const viewer = rolesList.find((r) => r.name === 'BanSourceViewer');
    expect(viewer?.can_manage_ban_sources).toBe(false);
  });

  it('POST /api/v1/roles persists can_manage_ban_sources', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: `BanRole-${Date.now()}`,
        color: '#abcdef',
        squad_permissions: [],
        panel_access: true,
        can_manage_ban_sources: true,
      }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as Record<string, unknown>).can_manage_ban_sources).toBe(true);
  });
});

describeIfDb('can_manage_ban_sources is only effective with panel_access', () => {
  it('a role with panel_access=false + can_manage_ban_sources=true yields no effective flag', async () => {
    const noPanelSteam = testSteamId(941004);
    const roleId = uuidv7();
    await h.db.insert(roles).values({
      id: roleId,
      name: 'GhostBanManager',
      color: '#654321',
      panelAccess: false,
      canManageBanSources: true,
    });
    await h.db.insert(players).values({
      steamId64: noPanelSteam,
      canonicalName: 'GhostManager',
      canonicalNameNormalized: 'ghostmanager',
      roleId,
    });
    invalidateAllPermissionCaches();
    const [row] = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.steamId64, noPanelSteam))
      .limit(1);
    // biome-ignore lint/style/noNonNullAssertion: player was just inserted
    const ctx = await loadUserPermissions(h.db, row!.id);
    expect(ctx.panelAccess).toBe(false);
    expect(ctx.canManageBanSources).toBe(false);
  });
});

describeIfDb('ban-sources URL guard (#855)', () => {
  it.each([
    'http://127.0.0.1:3000/api/v1/players',
    'http://localhost:3000/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://[::1]/',
    'file:///etc/passwd',
    'ftp://bans.example.com/bans.cfg',
  ])('refuses to create a source that points at %s', async (url) => {
    const { statusCode, body } = await createSource(managerCookie, { url });
    expect(statusCode).toBe(400);
    expect(JSON.stringify(body)).toContain('url_not_allowed');
  });

  it('refuses to repoint an existing source at an internal address', async () => {
    const created = await createSource(managerCookie);
    expect(created.statusCode).toBe(201);
    const id = created.body.id as string;

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/ban-sources/${id}`,
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('url_not_allowed');

    const [row] = await h.db
      .select({ url: externalBanSources.url })
      .from(externalBanSources)
      .where(eq(externalBanSources.id, id));
    expect(row?.url).toBe('https://collabans.example.com/bans.cfg');
  });
});
