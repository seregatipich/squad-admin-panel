import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = 76561198914500001n;
const SECOND_OWNER_STEAM = 76561198914500002n;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('DELETE /api/v1/roles/:id/members/:playerId — last-Owner invariant', () => {
  let h: IntegrationHarness;
  let ownerRoleId: string;
  let secondOwnerId: string;
  let cookie: string;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
    const ownerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    if (!ownerRows[0]) throw new Error('Owner role not found in isolated schema');
    ownerRoleId = ownerRows[0].id;

    const inserted = await h.db
      .insert(players)
      .values({
        steamId64: SECOND_OWNER_STEAM,
        canonicalName: 'Second Owner',
        canonicalNameNormalized: 'second owner',
        roleId: ownerRoleId,
      })
      .returning({ id: players.id });
    if (!inserted[0]) throw new Error('failed to seed second owner');
    secondOwnerId = inserted[0].id;

    cookie = await loginAsOwner(h);
  });

  afterEach(async () => {
    if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
    await h.cleanup();
  });

  it('returns 409 cannot_remove_last_owner when exactly one Owner remains', async () => {
    // Remove the second Owner first so only the seeded owner is left.
    const first = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${ownerRoleId}/members/${secondOwnerId}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${ownerRoleId}/members/${h.seed.ownerPlayerId}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'cannot_remove_last_owner' });

    const remaining = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));
    expect(remaining).toHaveLength(1);
  });

  it('the DB trigger allows only one of two truly concurrent last-Owner removals to succeed', async () => {
    // Exercises the migration 0107 trigger directly over two dedicated
    // connections, bypassing the app's pre-check entirely: this is exactly
    // the TOCTOU window the trigger exists to close (two writers who each
    // read "2 owners" before either commits). Each removal races as its own
    // implicit single-statement transaction, so the trigger's
    // pg_advisory_xact_lock is the only thing serializing them.
    const clientA = postgres(h.url, { max: 1, prepare: false, onnotice: () => undefined });
    const clientB = postgres(h.url, { max: 1, prepare: false, onnotice: () => undefined });

    try {
      // `h.url` already points at this test's own isolated database (see
      // `databaseUrl()` in isolated-db.ts) — tables live in its default
      // `public` schema, unqualified, same as the app's own connection.
      const results = await Promise.allSettled([
        clientA.unsafe('UPDATE players SET role_id = NULL WHERE id = $1', [h.seed.ownerPlayerId]),
        clientB.unsafe('UPDATE players SET role_id = NULL WHERE id = $1', [secondOwnerId]),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected).toBeDefined();
      const reason = (rejected as PromiseRejectedResult).reason as {
        code?: string;
        constraint_name?: string;
      };
      expect(reason.code).toBe('23514');
      expect(reason.constraint_name).toBe('players_last_owner_guard');

      const remaining = await h.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.roleId, ownerRoleId));
      expect(remaining).toHaveLength(1);
    } finally {
      await Promise.all([clientA.end({ timeout: 5 }), clientB.end({ timeout: 5 })]);
    }
  });

  it('bulk-delete rejects removing every Owner in one request and removes none of them', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${ownerRoleId}/members/bulk-delete`,
      headers: { cookie },
      payload: { player_ids: [h.seed.ownerPlayerId, secondOwnerId] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'cannot_remove_last_owner' });

    const remaining = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));
    expect(remaining).toHaveLength(2);
  });

  it('move rejects moving every Owner out in one request and moves none of them', async () => {
    const targetRoleId = uuidv7();
    await h.db.insert(roles).values({ id: targetRoleId, name: 'MoveTarget', panelAccess: false });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${ownerRoleId}/members/move`,
      headers: { cookie },
      payload: {
        player_ids: [h.seed.ownerPlayerId, secondOwnerId],
        target_role_id: targetRoleId,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'cannot_remove_last_owner' });

    const remaining = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));
    expect(remaining).toHaveLength(2);
  });
});
