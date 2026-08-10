import { players, roles, servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache, loadUserPermissions } from '../../src/lib/rbac.js';
import { createSession, resolveSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(735000);
const MEMBER_STEAM = testSteamId(735001);
const SYNC_STREAM = (serverId: string) => `events:admins-cfg-sync:${serverId}`;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('DELETE /api/v1/roles/:id/members/:playerId — mutation outcome', () => {
  let h: IntegrationHarness;
  let memberId: string;
  let actualRoleId: string;
  let unrelatedRoleId: string;
  let serverId: string;
  let ownerCookie: string;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });

    actualRoleId = uuidv7();
    unrelatedRoleId = uuidv7();
    await h.db.insert(roles).values([
      { id: actualRoleId, name: `Actual-${actualRoleId}`, panelAccess: true },
      { id: unrelatedRoleId, name: `Unrelated-${unrelatedRoleId}`, panelAccess: false },
    ]);

    const inserted = await h.db
      .insert(players)
      .values({
        steamId64: MEMBER_STEAM,
        canonicalName: 'Role removal target',
        canonicalNameNormalized: 'role removal target',
        roleId: actualRoleId,
        roleComment: 'keep this assignment',
        roleExpiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: players.id });
    if (!inserted[0]) throw new Error('failed to seed role removal target');
    memberId = inserted[0].id;

    serverId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: `Role removal sync ${serverId}`,
      slug: `role-removal-${serverId}`,
      status: 'stopped' as 'stopped',
    });

    ownerCookie = await loginAsOwner(h);
  });

  afterEach(async () => {
    invalidatePermissionCache(memberId);
    if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
    await h.cleanup();
  });

  it('keeps membership, session, permission cache, and sync unchanged for a non-member', async () => {
    const targetSession = await createSession(h.db, h.redis, {
      playerId: memberId,
      ip: null,
      userAgent: 'role-removal-regression',
      ttlMs: 60_000,
    });
    const cachedPermissions = await loadUserPermissions(h.db, memberId);
    expect(cachedPermissions.roleId).toBe(actualRoleId);

    const streamLengthBefore = await h.redis.xlen(SYNC_STREAM(serverId));
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${unrelatedRoleId}/members/${memberId}`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const stored = await h.db
      .select({
        roleId: players.roleId,
        roleComment: players.roleComment,
        roleExpiresAt: players.roleExpiresAt,
      })
      .from(players)
      .where(and(eq(players.id, memberId), eq(players.steamId64, MEMBER_STEAM)))
      .limit(1);
    expect(stored[0]).toMatchObject({
      roleId: actualRoleId,
      roleComment: 'keep this assignment',
    });
    expect(stored[0]?.roleExpiresAt).not.toBeNull();
    expect(await h.redis.xlen(SYNC_STREAM(serverId))).toBe(streamLengthBefore);
    expect(await resolveSession(h.db, h.redis, targetSession.token)).toMatchObject({
      id: targetSession.session.id,
      playerId: memberId,
    });
    expect(await loadUserPermissions(h.db, memberId)).toBe(cachedPermissions);
  });

  it('clears assignment metadata and runs side effects once for an actual member', async () => {
    const targetSession = await createSession(h.db, h.redis, {
      playerId: memberId,
      ip: null,
      userAgent: 'role-removal-member',
      ttlMs: 60_000,
    });
    const cachedPermissions = await loadUserPermissions(h.db, memberId);
    const streamLengthBefore = await h.redis.xlen(SYNC_STREAM(serverId));

    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${actualRoleId}/members/${memberId}`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const stored = await h.db
      .select({
        roleId: players.roleId,
        roleComment: players.roleComment,
        roleExpiresAt: players.roleExpiresAt,
      })
      .from(players)
      .where(and(eq(players.id, memberId), eq(players.steamId64, MEMBER_STEAM)))
      .limit(1);
    expect(stored[0]).toEqual({
      roleId: null,
      roleComment: null,
      roleExpiresAt: null,
    });
    expect(await h.redis.xlen(SYNC_STREAM(serverId))).toBe(streamLengthBefore + 1);
    expect(await resolveSession(h.db, h.redis, targetSession.token)).toBeNull();
    const permissionsAfter = await loadUserPermissions(h.db, memberId);
    expect(permissionsAfter).not.toBe(cachedPermissions);
    expect(permissionsAfter.roleId).toBeNull();
  });
});
