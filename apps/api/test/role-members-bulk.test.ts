import { adminsCfgSyncOutbox, players, roles, servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM = testSteamId(730000);
const PLAYER_A = testSteamId(730001);
const PLAYER_B = testSteamId(730002);
const PLAYER_C = testSteamId(730003);
const UNKNOWN_STEAM = testSteamId(730099); // valid 17-digit id, never inserted

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('role-members bulk toolkit', () => {
  let h: IntegrationHarness;
  let viewerRoleId: string;
  let targetRoleId: string;
  let serverId: string;

  async function seedPlayer(opts: {
    steamId64: bigint;
    name: string;
    roleId?: string | null;
    comment?: string | null;
  }): Promise<string> {
    const rows = await h.db
      .insert(players)
      .values({
        steamId64: opts.steamId64,
        canonicalName: opts.name,
        canonicalNameNormalized: opts.name.toLowerCase(),
        roleId: opts.roleId ?? null,
        roleComment: opts.comment ?? null,
      })
      .returning({ id: players.id });
    if (!rows[0]) throw new Error('failed to seed player');
    return rows[0].id;
  }

  async function memberSteamIds(roleId: string, cookie: string): Promise<string[]> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/roles/${roleId}/members?limit=500`,
      headers: { cookie },
    });
    const body = res.json() as { items: Array<{ steam_id64: string | null }> };
    return body.items.map((i) => i.steam_id64).filter((s): s is string => s !== null);
  }

  async function syncTaskCount(): Promise<number> {
    return (
      await h.db
        .select({ id: adminsCfgSyncOutbox.id })
        .from(adminsCfgSyncOutbox)
        .where(eq(adminsCfgSyncOutbox.serverId, serverId))
    ).length;
  }

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });

    const viewerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Viewer'), eq(roles.isSystemRole, false)))
      .limit(1);
    if (!viewerRows[0]) throw new Error('Viewer role not found in isolated schema');
    viewerRoleId = viewerRows[0].id;

    targetRoleId = uuidv7();
    await h.db.insert(roles).values({ id: targetRoleId, name: 'MoveTarget', panelAccess: false });

    serverId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Sync Target',
      slug: 'sync-target',
      status: 'stopped' as 'stopped',
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  // Cases assert the exact member lists of the shared roles, so drop the
  // players each case seeded (their role assignments go with them).
  afterEach(async () => {
    if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
    for (const sid of [PLAYER_A, PLAYER_B, PLAYER_C]) {
      await h.db.delete(players).where(eq(players.steamId64, sid));
    }
  });

  it('requires authentication for import', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/import`,
      payload: { csv: `${PLAYER_A}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('import: valid CSV assigns every listed player and persists comments', async () => {
    await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha' });
    await seedPlayer({ steamId64: PLAYER_B, name: 'Bravo' });
    const cookie = await loginAsOwner(h);

    const before = await syncTaskCount();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/import`,
      headers: { cookie },
      payload: { csv: `${PLAYER_A};сезонный VIP\n${PLAYER_B}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, imported: 2 });

    const rows = await h.db
      .select({
        steamId64: players.steamId64,
        roleId: players.roleId,
        comment: players.roleComment,
      })
      .from(players)
      .where(eq(players.roleId, viewerRoleId));
    const bySteam = new Map(rows.map((r) => [r.steamId64?.toString(), r]));
    expect(bySteam.get(PLAYER_A.toString())?.comment).toBe('сезонный VIP');
    expect(bySteam.get(PLAYER_B.toString())?.comment).toBeNull();

    // Sync was enqueued exactly once for the active server.
    expect(await syncTaskCount()).toBe(before + 1);
  });

  it('import is ALL-OR-NOTHING: one unknown SteamID rejects the whole file, assigns nothing', async () => {
    await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha' });
    const cookie = await loginAsOwner(h);

    const before = await syncTaskCount();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/import`,
      headers: { cookie },
      payload: { csv: `${PLAYER_A}\n${UNKNOWN_STEAM}` },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      error: string;
      imported: number;
      errors: Array<{ line: number; steam_id64: string; reason: string }>;
    };
    expect(body.error).toBe('validation_failed');
    expect(body.imported).toBe(0);
    expect(body.errors).toEqual([
      { line: 2, steam_id64: UNKNOWN_STEAM.toString(), reason: 'player_not_found' },
    ]);

    // The GOOD row on line 1 must NOT have been assigned.
    const a = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, PLAYER_A))
      .limit(1);
    expect(a[0]?.roleId).toBeNull();

    // No sync enqueued because nothing was written.
    expect(await syncTaskCount()).toBe(before);
  });

  it('import: a malformed (non-numeric) row rejects the whole file and names the line', async () => {
    await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha' });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/import`,
      headers: { cookie },
      payload: { csv: `${PLAYER_A}\nnot-a-steam-id` },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      imported: number;
      errors: Array<{ line: number; reason: string }>;
    };
    expect(body.imported).toBe(0);
    expect(body.errors).toEqual([
      { line: 2, steam_id64: 'not-a-steam-id', reason: 'invalid_steam_id64' },
    ]);

    const a = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, PLAYER_A))
      .limit(1);
    expect(a[0]?.roleId).toBeNull();
  });

  it('import: a duplicate SteamID inside the file is rejected', async () => {
    await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha' });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/import`,
      headers: { cookie },
      payload: { csv: `${PLAYER_A}\n${PLAYER_A}` },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { errors: Array<{ line: number; reason: string }> };
    expect(body.errors).toEqual([
      { line: 2, steam_id64: PLAYER_A.toString(), reason: 'duplicate_steam_id64' },
    ]);
  });

  it('import into the Owner role is forbidden', async () => {
    const ownerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const ownerRoleId = ownerRows[0]?.id;
    if (!ownerRoleId) throw new Error('Owner role missing');
    await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha' });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${ownerRoleId}/members/import`,
      headers: { cookie },
      payload: { csv: `${PLAYER_A}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('owner_assignment_forbidden');
  });

  it('export: returns the role members as CSV with comments', async () => {
    await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha', roleId: viewerRoleId, comment: 'keep' });
    await seedPlayer({ steamId64: PLAYER_B, name: 'Bravo', roleId: viewerRoleId });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/roles/${viewerRoleId}/members/export`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const text = res.body;
    expect(text).toContain('steam_id64;canonical_name;comment');
    expect(text).toContain(`${PLAYER_A};Alpha;keep`);
    expect(text).toContain(`${PLAYER_B};Bravo;`);
  });

  it('bulk-delete: removes exactly the selected members, leaving the rest', async () => {
    const idA = await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha', roleId: viewerRoleId });
    const idB = await seedPlayer({ steamId64: PLAYER_B, name: 'Bravo', roleId: viewerRoleId });
    await seedPlayer({ steamId64: PLAYER_C, name: 'Charlie', roleId: viewerRoleId });
    const cookie = await loginAsOwner(h);

    const before = await syncTaskCount();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/bulk-delete`,
      headers: { cookie },
      payload: { player_ids: [idA, idB] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, removed: 2 });

    const remaining = await memberSteamIds(viewerRoleId, cookie);
    expect(remaining).toEqual([PLAYER_C.toString()]);
    expect(await syncTaskCount()).toBe(before + 1);
  });

  it('bulk-delete only affects members of THIS role', async () => {
    const idA = await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha', roleId: viewerRoleId });
    // B belongs to the target role, not viewer — must be untouched.
    const idB = await seedPlayer({ steamId64: PLAYER_B, name: 'Bravo', roleId: targetRoleId });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/bulk-delete`,
      headers: { cookie },
      payload: { player_ids: [idA, idB] },
    });
    expect(res.json()).toEqual({ ok: true, removed: 1 });

    const b = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, idB))
      .limit(1);
    expect(b[0]?.roleId).toBe(targetRoleId);
  });

  it('move: reassigns selected members to the target role', async () => {
    const idA = await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha', roleId: viewerRoleId });
    await seedPlayer({ steamId64: PLAYER_B, name: 'Bravo', roleId: viewerRoleId });
    const cookie = await loginAsOwner(h);

    const before = await syncTaskCount();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/move`,
      headers: { cookie },
      payload: { player_ids: [idA], target_role_id: targetRoleId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, moved: 1 });

    expect(await memberSteamIds(targetRoleId, cookie)).toEqual([PLAYER_A.toString()]);
    expect(await memberSteamIds(viewerRoleId, cookie)).toEqual([PLAYER_B.toString()]);
    expect(await syncTaskCount()).toBe(before + 1);
  });

  it('move: rejects a missing target role', async () => {
    const idA = await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha', roleId: viewerRoleId });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/move`,
      headers: { cookie },
      payload: { player_ids: [idA], target_role_id: uuidv7() },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('target_role_not_found');
  });

  it('move: forbids the Owner role as target', async () => {
    const ownerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const ownerRoleId = ownerRows[0]?.id;
    if (!ownerRoleId) throw new Error('Owner role missing');
    const idA = await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha', roleId: viewerRoleId });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${viewerRoleId}/members/move`,
      headers: { cookie },
      payload: { player_ids: [idA], target_role_id: ownerRoleId },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('owner_assignment_forbidden');
  });

  it('GET members exposes the per-assignment role_comment', async () => {
    await seedPlayer({ steamId64: PLAYER_A, name: 'Alpha', roleId: viewerRoleId, comment: 'hi' });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/roles/${viewerRoleId}/members`,
      headers: { cookie },
    });
    const body = res.json() as {
      items: Array<{ steam_id64: string | null; role_comment: string | null }>;
    };
    const a = body.items.find((i) => i.steam_id64 === PLAYER_A.toString());
    expect(a?.role_comment).toBe('hi');
  });
});
