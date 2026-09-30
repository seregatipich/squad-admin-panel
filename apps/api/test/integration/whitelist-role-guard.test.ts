import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

/**
 * Issue #8: the whitelist paths (application approval, "В whitelist" member
 * add, CSV import, whitelist-role designation) are gated only on
 * `whitelist:edit`, which every panel-access role derives. They must never
 * grant or overwrite roles beyond the configured whitelist role for a caller
 * without `user:manage_roles`, and must never grant or strip the Owner role.
 */

const OWNER_STEAM = testSteamId(174001);
const SECOND_OWNER_STEAM = testSteamId(174002);
const MODERATOR_STEAM = testSteamId(174003);
const STAFF_STEAM = testSteamId(174004);
const TWINK_OWNER_ROLE_STEAM = testSteamId(174010);
const TWINK_STAFF_ROLE_STEAM = testSteamId(174011);
const TWINK_WHITELIST_STEAM = testSteamId(174012);
const MEMBER_ROLELESS_STEAM = testSteamId(174020);
const MEMBER_STAFF_STEAM = testSteamId(174021);
const MEMBER_VIP_STEAM = testSteamId(174022);
const IMPORT_ROLELESS_STEAM = testSteamId(174030);
const IMPORT_STAFF_STEAM = testSteamId(174031);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let moderatorCookie: string;
let ownerRoleId: string;
let moderatorRoleId: string;
let staffRoleId: string;
let vipRoleId: string;
let whitelistRoleId: string;
let secondOwnerId: string;
let moderatorId: string;
let staffId: string;
let memberRolelessId: string;
let memberStaffId: string;
let memberVipId: string;

async function createRole(opts: {
  name: string;
  panelAccess: boolean;
  canAssignRoles?: boolean;
}): Promise<string> {
  const id = uuidv7();
  await h.db.insert(roles).values({
    id,
    name: opts.name,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canAssignRoles: opts.canAssignRoles ?? false,
  });
  return id;
}

async function createPlayer(steamId64: bigint, roleId: string | null = null): Promise<string> {
  const id = uuidv7();
  const stub = `Guard${String(steamId64).slice(-5)}`;
  await h.db.insert(players).values({
    id,
    steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
  return id;
}

async function loginAs(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'wl-role-guard-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function roleOf(steamId64: bigint): Promise<string | null> {
  const [row] = await h.db
    .select({ roleId: players.roleId })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  return row?.roleId ?? null;
}

/** Submits as the applicant's own Steam-verified session (#375). */
async function submit(steamId64: bigint): Promise<string> {
  const [player] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!player) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: player.id,
    ip: null,
    userAgent: 'wl-role-guard-applicant',
    ttlMs: 21_600_000,
    scope: 'self_service',
  });
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/public/whitelist/applications',
    headers: { cookie: `__Host-sid=${token}` },
    payload: { body: 'guard test' },
  });
  if (res.statusCode !== 201) throw new Error(`submit failed: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}

async function approve(cookie: string, applicationId: string, roleId?: string) {
  return h.app.inject({
    method: 'PATCH',
    url: `/api/v1/whitelist/applications/${applicationId}`,
    headers: { cookie },
    payload: roleId ? { status: 'approved', role_id: roleId } : { status: 'approved' },
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'GuardOwner' },
    // A second, unloginable Owner keeps the last-Owner DB trigger from masking
    // an unauthorized demotion as a 500.
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const [ownerRow] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRow) throw new Error('Owner role missing');
  ownerRoleId = ownerRow.id;

  moderatorRoleId = await createRole({ name: 'GuardModerator', panelAccess: true });
  staffRoleId = await createRole({ name: 'GuardStaff', panelAccess: true, canAssignRoles: true });
  vipRoleId = await createRole({ name: 'GuardVip', panelAccess: false });
  whitelistRoleId = await createRole({ name: 'GuardWhitelist', panelAccess: false });

  secondOwnerId = await createPlayer(SECOND_OWNER_STEAM, ownerRoleId);
  moderatorId = await createPlayer(MODERATOR_STEAM, moderatorRoleId);
  staffId = await createPlayer(STAFF_STEAM, staffRoleId);
  await createPlayer(TWINK_OWNER_ROLE_STEAM);
  await createPlayer(TWINK_STAFF_ROLE_STEAM);
  await createPlayer(TWINK_WHITELIST_STEAM);
  memberRolelessId = await createPlayer(MEMBER_ROLELESS_STEAM);
  memberStaffId = await createPlayer(MEMBER_STAFF_STEAM, staffRoleId);
  memberVipId = await createPlayer(MEMBER_VIP_STEAM, vipRoleId);
  await createPlayer(IMPORT_ROLELESS_STEAM);
  await createPlayer(IMPORT_STAFF_STEAM, staffRoleId);

  const settings = await h.app.inject({
    method: 'PUT',
    url: '/api/v1/whitelist/settings',
    headers: { cookie: ownerCookie },
    payload: { whitelist_role_id: whitelistRoleId },
  });
  if (settings.statusCode !== 200) throw new Error(`whitelist settings: ${settings.body}`);
  const portal = await h.app.inject({
    method: 'PUT',
    url: '/api/v1/whitelist/applications/settings',
    headers: { cookie: ownerCookie },
    payload: { enabled: true, default_days: null },
  });
  if (portal.statusCode !== 200) throw new Error(`portal settings: ${portal.body}`);

  moderatorCookie = await loginAs(moderatorId);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('PATCH /api/v1/whitelist/applications/:id — role guard (#371)', () => {
  it('forbids granting the Owner role on approval, even for the Owner', async () => {
    const byModerator = await approve(
      moderatorCookie,
      await submit(TWINK_OWNER_ROLE_STEAM),
      ownerRoleId,
    );
    expect(byModerator.statusCode).toBe(403);
    expect(byModerator.json()).toEqual({ error: 'owner_assignment_forbidden' });
    expect(await roleOf(TWINK_OWNER_ROLE_STEAM)).toBeNull();

    const pending = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/applications?status=pending',
      headers: { cookie: ownerCookie },
    });
    const application = pending
      .json<{ items: Array<{ id: string; steam_id64: string }> }>()
      .items.find((item) => item.steam_id64 === TWINK_OWNER_ROLE_STEAM.toString());
    if (!application) throw new Error('application should still be pending');
    const byOwner = await approve(ownerCookie, application.id, ownerRoleId);
    expect(byOwner.statusCode).toBe(403);
    expect(byOwner.json()).toEqual({ error: 'owner_assignment_forbidden' });
    expect(await roleOf(TWINK_OWNER_ROLE_STEAM)).toBeNull();
  });

  it('forbids a reviewer without user:manage_roles from granting a non-whitelist role', async () => {
    const res = await approve(moderatorCookie, await submit(TWINK_STAFF_ROLE_STEAM), staffRoleId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'role_assignment_forbidden' });
    expect(await roleOf(TWINK_STAFF_ROLE_STEAM)).toBeNull();
  });

  it('forbids a reviewer without user:manage_roles from overwriting an applicant’s other role', async () => {
    const res = await approve(moderatorCookie, await submit(STAFF_STEAM));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'role_assignment_forbidden' });
    expect(await roleOf(STAFF_STEAM)).toBe(staffRoleId);
  });

  it('never demotes an Owner applicant, even when the reviewer can manage roles', async () => {
    const res = await approve(ownerCookie, await submit(SECOND_OWNER_STEAM), vipRoleId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'owner_role_protected' });
    expect(await roleOf(SECOND_OWNER_STEAM)).toBe(ownerRoleId);
  });

  it('still lets a reviewer without user:manage_roles grant the whitelist role to a roleless applicant', async () => {
    const res = await approve(moderatorCookie, await submit(TWINK_WHITELIST_STEAM));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ granted_role_id: string }>().granted_role_id).toBe(whitelistRoleId);
    expect(await roleOf(TWINK_WHITELIST_STEAM)).toBe(whitelistRoleId);
  });
});

describeIfDb('POST /api/v1/whitelist/members — role guard (#476)', () => {
  async function addMember(cookie: string, playerId: string) {
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie },
      payload: { player_id: playerId },
    });
  }

  it('never moves an Owner into the whitelist, whoever asks', async () => {
    const byModerator = await addMember(moderatorCookie, secondOwnerId);
    expect(byModerator.statusCode).toBe(409);
    expect(byModerator.json()).toEqual({ error: 'owner_role_protected' });

    const byOwner = await addMember(ownerCookie, secondOwnerId);
    expect(byOwner.statusCode).toBe(409);
    expect(byOwner.json()).toEqual({ error: 'owner_role_protected' });
    expect(await roleOf(SECOND_OWNER_STEAM)).toBe(ownerRoleId);
  });

  it('forbids a caller without user:manage_roles from overwriting another role', async () => {
    const other = await addMember(moderatorCookie, memberStaffId);
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: 'role_assignment_forbidden' });
    expect(await roleOf(MEMBER_STAFF_STEAM)).toBe(staffRoleId);

    const self = await addMember(moderatorCookie, moderatorId);
    expect(self.statusCode).toBe(403);
    expect(self.json()).toEqual({ error: 'role_assignment_forbidden' });
    expect(await roleOf(MODERATOR_STEAM)).toBe(moderatorRoleId);
  });

  it('lets a caller without user:manage_roles whitelist a roleless player', async () => {
    const res = await addMember(moderatorCookie, memberRolelessId);
    expect(res.statusCode).toBe(201);
    expect(await roleOf(MEMBER_ROLELESS_STEAM)).toBe(whitelistRoleId);
  });

  it('lets a caller with user:manage_roles replace a non-Owner role', async () => {
    const res = await addMember(ownerCookie, memberVipId);
    expect(res.statusCode).toBe(201);
    expect(await roleOf(MEMBER_VIP_STEAM)).toBe(whitelistRoleId);
  });
});

describeIfDb('POST /api/v1/whitelist/import — role guard (#476)', () => {
  it('skips Owners and, without user:manage_roles, players holding another role', async () => {
    const csv = [
      `${IMPORT_ROLELESS_STEAM},roleless`,
      `${IMPORT_STAFF_STEAM},staff`,
      `${SECOND_OWNER_STEAM},owner`,
    ].join('\n');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/import',
      headers: { cookie: moderatorCookie },
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      imported: number;
      skipped: Array<{ line: number; reason: string }>;
    }>();
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([
      expect.objectContaining({ line: 2, reason: 'role_assignment_forbidden' }),
      expect.objectContaining({ line: 3, reason: 'owner_role_protected' }),
    ]);
    expect(await roleOf(IMPORT_ROLELESS_STEAM)).toBe(whitelistRoleId);
    expect(await roleOf(IMPORT_STAFF_STEAM)).toBe(staffRoleId);
    expect(await roleOf(SECOND_OWNER_STEAM)).toBe(ownerRoleId);
  });
});

describeIfDb('PUT /api/v1/whitelist/settings — role guard (#476)', () => {
  it('forbids a caller without user:manage_roles from designating the whitelist role', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: moderatorCookie },
      payload: { whitelist_role_id: staffRoleId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'role_assignment_forbidden' });

    const current = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: ownerCookie },
    });
    expect(current.json<{ whitelist_role_id: string }>().whitelist_role_id).toBe(whitelistRoleId);
  });

  it('lets a caller with user:manage_roles designate the whitelist role', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: await loginAs(staffId) },
      payload: { whitelist_role_id: vipRoleId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ whitelist_role_id: string }>().whitelist_role_id).toBe(vipRoleId);
  });
});
