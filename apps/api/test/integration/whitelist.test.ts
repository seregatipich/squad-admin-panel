import { adminsCfgSyncOutbox, panelMeta, players, roles, servers } from '@squad/db/schema';
import { eq, inArray, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(165001);
const OUTSIDER_STEAM = testSteamId(165002);
const MEMBER_A_STEAM = testSteamId(165010);
const MEMBER_B_STEAM = testSteamId(165011);
const IMPORT_KNOWN_STEAM = testSteamId(165020);
const UNKNOWN_STEAM = testSteamId(165099);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let outsiderCookie: string;
let whitelistRoleId: string;
let ownerRoleId: string;
let memberAId: string;
let memberBId: string;

async function createRole(opts: {
  name: string;
  panelAccess: boolean;
  isSystemRole?: boolean;
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.name,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    isSystemRole: opts.isSystemRole ?? false,
  });
  return roleId;
}

async function createPlayer(steamId64: bigint, roleId: string | null = null): Promise<string> {
  const id = uuidv7();
  const stub = `Player${String(steamId64).slice(-5)}`;
  await h.db.insert(players).values({
    id,
    steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
  return id;
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'wl1-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'WlOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const [ownerRoleRow] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Owner'))
    .limit(1);
  // biome-ignore lint/style/noNonNullAssertion: seeded by migration 0009
  ownerRoleId = ownerRoleRow!.id;

  whitelistRoleId = await createRole({ name: 'WlWhitelisted', panelAccess: false });
  const outsiderRoleId = await createRole({ name: 'WlOutsider', panelAccess: false });
  await createPlayer(OUTSIDER_STEAM, outsiderRoleId);
  outsiderCookie = await loginAsSteam(OUTSIDER_STEAM);

  memberAId = await createPlayer(MEMBER_A_STEAM);
  memberBId = await createPlayer(MEMBER_B_STEAM);
  await createPlayer(IMPORT_KNOWN_STEAM);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET/PUT /api/v1/whitelist/settings', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/whitelist/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without panel access', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns null before any whitelist role is configured', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ whitelist_role_id: null, whitelist_role_name: null });
  });

  it('rejects assigning the Owner role as the whitelist role', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: ownerCookie },
      payload: { whitelist_role_id: ownerRoleId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('owner_role_forbidden');
  });

  it('rejects an unknown role id with 404', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: ownerCookie },
      payload: { whitelist_role_id: uuidv7() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('sets the whitelist role and writes an audit row', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: ownerCookie },
      payload: { whitelist_role_id: whitelistRoleId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ whitelist_role_id: string; whitelist_role_name: string }>();
    expect(body.whitelist_role_id).toBe(whitelistRoleId);
    expect(body.whitelist_role_name).toBe('WlWhitelisted');

    const [row] = await h.db
      .select({ whitelistRoleId: panelMeta.whitelistRoleId })
      .from(panelMeta)
      .where(eq(panelMeta.id, 1))
      .limit(1);
    expect(row?.whitelistRoleId).toBe(whitelistRoleId);

    await assertAuditRow(h, { action: 'whitelist.settings.update', resource: 'panel_meta' });
  });
});

describeIfDb('POST/DELETE /api/v1/whitelist/members', () => {
  it('assigns the whitelist role on first call (201) and no-ops on the second (200)', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: memberAId },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ ok: true, changed: true });

    const [afterFirst] = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, memberAId))
      .limit(1);
    expect(afterFirst?.roleId).toBe(whitelistRoleId);

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: memberAId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, changed: false });

    const [afterSecond] = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, memberAId))
      .limit(1);
    expect(afterSecond?.roleId).toBe(whitelistRoleId);
  });

  it('returns 404 for an unknown player id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: uuidv7() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects members mutation for a user without panel access', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: outsiderCookie },
      payload: { player_id: memberBId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('removes the whitelist role via DELETE and is idempotent', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: memberBId },
    });

    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/whitelist/members/${memberBId}`,
      headers: { cookie: ownerCookie },
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ ok: true, changed: true });

    const [row] = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, memberBId))
      .limit(1);
    expect(row?.roleId).toBeNull();

    const removeAgain = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/whitelist/members/${memberBId}`,
      headers: { cookie: ownerCookie },
    });
    expect(removeAgain.statusCode).toBe(200);
    expect(removeAgain.json()).toEqual({ ok: true, changed: false });
  });

  it('returns 404 deleting an unknown player id', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/whitelist/members/${uuidv7()}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describeIfDb('POST /api/v1/whitelist/import', () => {
  it('imports valid rows and reports malformed / unresolvable ones', async () => {
    const csv = [
      `${IMPORT_KNOWN_STEAM},imported via csv`,
      'not-a-steam-id,bad row',
      `${UNKNOWN_STEAM},no such player`,
      'a,b,c',
      '',
    ].join('\n');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/import',
      headers: { cookie: ownerCookie },
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      total_rows: number;
      imported: number;
      skipped: Array<{ line: number; reason: string }>;
    }>();
    expect(body.total_rows).toBe(4);
    expect(body.imported).toBe(1);
    expect(body.skipped).toHaveLength(3);
    expect(body.skipped.map((s) => s.reason).sort()).toEqual(
      ['invalid_steam_id64', 'malformed_row', 'player_not_found'].sort(),
    );

    const [row] = await h.db
      .select({ roleId: players.roleId, roleComment: players.roleComment })
      .from(players)
      .where(eq(players.steamId64, IMPORT_KNOWN_STEAM))
      .limit(1);
    expect(row?.roleId).toBe(whitelistRoleId);
    expect(row?.roleComment).toBe('imported via csv');
  });

  it('rejects import for a user without panel access', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/import',
      headers: { cookie: outsiderCookie },
      payload: { csv: `${IMPORT_KNOWN_STEAM}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('GET /api/v1/whitelist/export', () => {
  it('exports current whitelist members as CSV', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/export',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.body;
    expect(text.startsWith('steam_id64,canonical_name,comment')).toBe(true);
    expect(text).toContain(String(IMPORT_KNOWN_STEAM));
    expect(text).toContain(String(MEMBER_A_STEAM));
  });

  it('rejects export for a user without panel access', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/export',
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

// WL-2: the "apply a whitelist group to every server in one action" criterion is
// satisfied by the global-role model — a whitelist mutation fans out to every
// active server's Admins.cfg via `publishAdminsCfgSyncForAllServers`. These cases
// lock that fan-out invariant for the whitelist path so a future refactor cannot
// silently regress it (see docs/architecture/decisions.md WL-2 ADR).
describeIfDb('whitelist mutations fan out to every active server (WL-2)', () => {
  const FANOUT_ADD_STEAM = testSteamId(165030);
  const FANOUT_REMOVE_STEAM = testSteamId(165031);
  const FANOUT_ZERO_STEAM = testSteamId(165032);
  const FANOUT_IDEM_STEAM = testSteamId(165033);

  let activeServerAId: string;
  let activeServerBId: string;
  let softDeletedServerId: string;
  let addPlayerId: string;
  let removePlayerId: string;
  let zeroPlayerId: string;
  let idemPlayerId: string;

  async function activeServerIds(): Promise<string[]> {
    const rows = await h.db
      .select({ id: servers.id })
      .from(servers)
      .where(isNull(servers.deletedAt));
    return rows.map((r) => r.id);
  }

  async function outboxRows(): Promise<Array<{ serverId: string; reason: string }>> {
    const rows = await h.db
      .select({ serverId: adminsCfgSyncOutbox.serverId, payload: adminsCfgSyncOutbox.payload })
      .from(adminsCfgSyncOutbox);
    return rows.map((r) => ({
      serverId: r.serverId,
      reason: (r.payload as { reason: string }).reason,
    }));
  }

  beforeAll(async () => {
    // Two active servers + one soft-deleted: proves the fan-out targets every
    // active server and never the soft-deleted one.
    activeServerAId = uuidv7();
    activeServerBId = uuidv7();
    softDeletedServerId = uuidv7();
    const stamp = Date.now();
    await h.db.insert(servers).values([
      { id: activeServerAId, displayName: 'wl2-fanout-a', slug: `wl2-fanout-a-${stamp}` },
      { id: activeServerBId, displayName: 'wl2-fanout-b', slug: `wl2-fanout-b-${stamp}` },
      {
        id: softDeletedServerId,
        displayName: 'wl2-fanout-deleted',
        slug: `wl2-fanout-deleted-${stamp}`,
        deletedAt: new Date(),
      },
    ]);

    addPlayerId = await createPlayer(FANOUT_ADD_STEAM);
    removePlayerId = await createPlayer(FANOUT_REMOVE_STEAM);
    zeroPlayerId = await createPlayer(FANOUT_ZERO_STEAM);
    idemPlayerId = await createPlayer(FANOUT_IDEM_STEAM);

    // Configure the whitelist role via the real route (idempotent), so the
    // shared-state guard on direct panel_meta writes stays satisfied.
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: ownerCookie },
      payload: { whitelist_role_id: whitelistRoleId },
    });
  }, 60_000);

  afterAll(async () => {
    await h.db
      .delete(servers)
      .where(inArray(servers.id, [activeServerAId, activeServerBId, softDeletedServerId]));
  });

  beforeEach(async () => {
    await h.db.delete(adminsCfgSyncOutbox);
  });

  it('adding a member enqueues one outbox row per active server, never the soft-deleted one', async () => {
    const activeIds = await activeServerIds();
    expect(activeIds).toEqual(expect.arrayContaining([activeServerAId, activeServerBId]));
    expect(activeIds).not.toContain(softDeletedServerId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: addPlayerId },
    });
    expect(res.statusCode).toBe(201);

    const rows = await outboxRows();
    expect(rows).toHaveLength(activeIds.length);
    expect(new Set(rows.map((r) => r.serverId))).toEqual(new Set(activeIds));
    expect(rows.map((r) => r.serverId)).not.toContain(softDeletedServerId);
    for (const row of rows) {
      expect(row.reason).toBe('whitelist.member.add');
    }
  });

  it('removing a member enqueues one outbox row per active server with reason whitelist.member.remove', async () => {
    // Arrange: assign the whitelist role first (its add fan-out is discarded).
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: removePlayerId },
    });
    await h.db.delete(adminsCfgSyncOutbox);

    const activeIds = await activeServerIds();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/whitelist/members/${removePlayerId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, changed: true });

    const rows = await outboxRows();
    expect(rows).toHaveLength(activeIds.length);
    expect(new Set(rows.map((r) => r.serverId))).toEqual(new Set(activeIds));
    expect(rows.map((r) => r.serverId)).not.toContain(softDeletedServerId);
    for (const row of rows) {
      expect(row.reason).toBe('whitelist.member.remove');
    }
  });

  it('enqueues nothing but still returns 2xx when there are no active servers', async () => {
    const activeIds = await activeServerIds();
    // Temporarily soft-delete every active server so the fan-out has no targets.
    await h.db.update(servers).set({ deletedAt: new Date() }).where(inArray(servers.id, activeIds));
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/whitelist/members',
        headers: { cookie: ownerCookie },
        payload: { player_id: zeroPlayerId },
      });
      expect(res.statusCode).toBe(201);
      expect(await outboxRows()).toHaveLength(0);
    } finally {
      await h.db.update(servers).set({ deletedAt: null }).where(inArray(servers.id, activeIds));
    }
  });

  it('an idempotent no-op re-add enqueues no additional outbox rows', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: idemPlayerId },
    });
    expect(first.statusCode).toBe(201);
    await h.db.delete(adminsCfgSyncOutbox);

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie: ownerCookie },
      payload: { player_id: idemPlayerId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, changed: false });
    expect(await outboxRows()).toHaveLength(0);
  });
});
