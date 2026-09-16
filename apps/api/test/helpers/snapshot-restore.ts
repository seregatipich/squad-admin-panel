import type { DatabaseClient } from '@squad/db';
import { panelMeta, players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';

export interface LiveStateSnapshot {
  panelMetaFlag: boolean;
  ownerSteamIds: (bigint | null)[];
  ownerRoleId: string;
}

export async function snapshotLiveOwnerState(db: DatabaseClient): Promise<LiveStateSnapshot> {
  const ownerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const ownerRoleId = ownerRows[0]?.id;
  if (!ownerRoleId) throw new Error('Owner role missing — migration 0009 not applied?');

  const meta = await db.select().from(panelMeta).where(eq(panelMeta.id, 1));
  const owners = await db
    .select({ steamId64: players.steamId64 })
    .from(players)
    .where(eq(players.roleId, ownerRoleId));

  return {
    panelMetaFlag: meta[0]?.firstOwnerClaimed ?? false,
    ownerSteamIds: owners.map((r) => r.steamId64),
    ownerRoleId,
  };
}

export async function maskLiveOwners(
  db: DatabaseClient,
  snapshot: LiveStateSnapshot,
): Promise<void> {
  for (const sid of snapshot.ownerSteamIds) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
  }
  await db.update(panelMeta).set({ firstOwnerClaimed: false }).where(eq(panelMeta.id, 1));
}

export async function restoreLiveOwners(
  db: DatabaseClient,
  snapshot: LiveStateSnapshot,
): Promise<void> {
  for (const sid of snapshot.ownerSteamIds) {
    await db
      .update(players)
      .set({ roleId: snapshot.ownerRoleId })
      .where(eq(players.steamId64, sid));
  }
  await db
    .update(panelMeta)
    .set({ firstOwnerClaimed: snapshot.panelMetaFlag })
    .where(eq(panelMeta.id, 1));
}

/**
 * Forces the singleton `panel_meta` row (id=1) into a known setup state.
 *
 * Setup completion is a one-way latch, so a suite exercising the pre- and
 * post-completion behaviour of `/api/v1/setup/*` must be able to reset it
 * between cases. This lives here (not in the test file) because the
 * test-isolation guard forbids unguarded `panel_meta` mutations in `*.test.ts`;
 * this helper is only safe against an **isolated-schema** harness
 * (`buildIntegrationApp` without `reusePublicSchema`), never the shared
 * `public` schema, since it overwrites real setup state unconditionally.
 */
export async function resetSetupState(
  db: DatabaseClient,
  state: { setupCompleted?: boolean; firstOwnerClaimed?: boolean; organizationName?: string } = {},
): Promise<void> {
  await db
    .update(panelMeta)
    .set({
      setupCompleted: state.setupCompleted ?? false,
      firstOwnerClaimed: state.firstOwnerClaimed ?? false,
      organizationName: state.organizationName ?? '',
    })
    .where(eq(panelMeta.id, 1));
}

/** Sets the whitelist role only in a per-test isolated database harness. */
export async function setIsolatedTestWhitelistRole(
  db: DatabaseClient,
  whitelistRoleId: string,
): Promise<void> {
  await db.update(panelMeta).set({ whitelistRoleId }).where(eq(panelMeta.id, 1));
}

export const TEST_STEAM_BASE = 76561197999000000n;
export function testSteamId(suffix: number): bigint {
  if (suffix < 0 || suffix > 999999) {
    throw new Error(`testSteamId suffix out of range: ${suffix}`);
  }
  return TEST_STEAM_BASE + BigInt(suffix);
}

export function isTestSteamId(steamId64: bigint): boolean {
  return steamId64 >= TEST_STEAM_BASE && steamId64 < TEST_STEAM_BASE + 1_000_000n;
}
