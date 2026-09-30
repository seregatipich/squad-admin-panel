import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import { raceAgainstOpenTransaction } from './helpers/row-lock.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness } from './integration/harness.js';

const FIRST_OWNER_STEAM = testSteamId(715001);
const SECOND_OWNER_STEAM = testSteamId(715002);

/**
 * Audit #71 (#237): the route's "last Owner" pre-check runs outside the
 * UPDATE's transaction, so two interleaved demotions of the last two Owners
 * both pass it. The authoritative invariant is the database guard
 * `players_last_owner_guard` (migration 0107), which serializes demotions on
 * an advisory lock and rejects the second one; `plugins/error-diag.ts` maps
 * that to the documented 409 `cannot_remove_last_owner`. These cases pin that
 * behaviour: the loser gets a 409 and exactly one Owner survives.
 *
 * The concurrent demotion of the first Owner is held open in a transaction
 * until the request — the second Owner demoting themselves — blocks on the
 * guard's advisory lock, so the interleaving is deterministic.
 */
describe('last-Owner demotion race', () => {
  let h: IntegrationHarness;
  let cookie: string;
  let ownerRoleId: string;
  let secondOwnerId: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: FIRST_OWNER_STEAM } });
    const [ownerRole] = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    if (!ownerRole) throw new Error('Owner role not seeded');
    ownerRoleId = ownerRole.id;
    const [second] = await h.db
      .insert(players)
      .values({
        steamId64: SECOND_OWNER_STEAM,
        canonicalName: 'SecondOwner',
        canonicalNameNormalized: 'secondowner',
        roleId: ownerRoleId,
      })
      .returning({ id: players.id });
    if (!second) throw new Error('second owner insert failed');
    secondOwnerId = second.id;

    // Only an Owner may demote an Owner (role hierarchy, #233), so the second
    // Owner is the caller and the target of every request below.
    invalidatePermissionCache(second.id);
    const { token } = await createSession(h.db, h.redis, {
      playerId: second.id,
      ip: null,
      userAgent: 'last-owner-race-test',
      ttlMs: 21_600_000,
    });
    cookie = `__Host-sid=${token}`;
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  async function ownerCount(): Promise<number> {
    const rows = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));
    return rows.length;
  }

  it('PUT answers 409 when a concurrent demotion leaves its target the last Owner', async () => {
    const res = await raceAgainstOpenTransaction(
      h.url,
      async (tx) => {
        await tx
          .update(players)
          .set({ roleId: null })
          .where(eq(players.steamId64, FIRST_OWNER_STEAM));
      },
      () =>
        h.app.inject({
          method: 'PUT',
          url: `/api/v1/players/${secondOwnerId}/role`,
          headers: { cookie },
          payload: { role_id: null },
        }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'cannot_remove_last_owner' });
    expect(await ownerCount()).toBe(1);
  });

  it('DELETE answers 409 when a concurrent demotion leaves its target the last Owner', async () => {
    // Restore two Owners: the first is promoted back, the second one stayed.
    await h.db
      .update(players)
      .set({ roleId: ownerRoleId })
      .where(eq(players.steamId64, FIRST_OWNER_STEAM));

    const res = await raceAgainstOpenTransaction(
      h.url,
      async (tx) => {
        await tx
          .update(players)
          .set({ roleId: null })
          .where(eq(players.steamId64, FIRST_OWNER_STEAM));
      },
      () =>
        h.app.inject({
          method: 'DELETE',
          url: `/api/v1/players/${secondOwnerId}/role`,
          headers: { cookie },
        }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'cannot_remove_last_owner' });
    expect(await ownerCount()).toBe(1);
  });
});
