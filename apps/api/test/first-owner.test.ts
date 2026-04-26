import * as schema from '@squad/db/schema';
import { panelMeta, players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFirstOwner } from '../src/lib/first-owner.js';

interface FakeBridge {
  fileRead: ReturnType<typeof vi.fn>;
  fileAtomicWrite: ReturnType<typeof vi.fn>;
}

const fakeBridge = (existingSentinel: boolean): FakeBridge => ({
  fileRead: vi.fn(async () => {
    if (existingSentinel) return { content: '{}' };
    throw new Error('ENOENT');
  }),
  fileAtomicWrite: vi.fn(async () => ({ status: 'written' })),
});

const TEST_PLAYER_A = 76561197999000010n;
const TEST_PLAYER_B = 76561197999000011n;

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ownerRoleId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  pgsql = postgres(url);
  db = drizzle(pgsql, { schema });

  const ownerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRows[0]) throw new Error('Owner role missing — migration 0009 not applied?');
  ownerRoleId = ownerRows[0].id;
});

afterAll(async () => {
  if (pgsql) await pgsql.end({ timeout: 5 });
});

// Snapshot real-world state once per file so we can restore it after the
// suite mutates panel_meta. The DB is shared with dev/staging — we MUST NOT
// strip Owner role from a real user to make a test pass.
let snapshotFirstOwnerClaimed = false;
let snapshotRealOwnerSteamIds: bigint[] = [];

beforeAll(async () => {
  // (existing beforeAll connection setup happens above; this hook augments it
  //  by capturing the live state we plan to perturb.)
}, 0);

beforeEach(async () => {
  // Capture live state on the first beforeEach (cheap; once per test run).
  if (snapshotRealOwnerSteamIds.length === 0) {
    const meta = await db.select().from(panelMeta).where(eq(panelMeta.id, 1));
    snapshotFirstOwnerClaimed = meta[0]?.firstOwnerClaimed ?? false;
    const realOwners = await db
      .select({ steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));
    snapshotRealOwnerSteamIds = realOwners.map((r) => r.steamId64);
  }

  // Reset panel_meta + ONLY clear Owner role from test players.
  await db.update(panelMeta).set({ firstOwnerClaimed: false }).where(eq(panelMeta.id, 1));
  for (const sid of [TEST_PLAYER_A, TEST_PLAYER_B]) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
  }
  // If a real Owner exists, the claim path's "Owner already exists" branch
  // would fire and the test wouldn't exercise the claim transition. Hide
  // them temporarily by clearing role_id; afterEach restores them.
  for (const sid of snapshotRealOwnerSteamIds) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
  }
  for (const sid of [TEST_PLAYER_A, TEST_PLAYER_B]) {
    const stub = `Test ${String(sid).slice(-4)}`;
    await db
      .insert(players)
      .values({
        steamId64: sid,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: null,
      })
      .onConflictDoUpdate({
        target: players.steamId64,
        set: { roleId: null },
      });
  }
});

afterEach(async () => {
  for (const sid of [TEST_PLAYER_A, TEST_PLAYER_B]) {
    await db.delete(players).where(eq(players.steamId64, sid));
  }
  // Restore real Owners we may have masked, and the original panel_meta flag.
  for (const sid of snapshotRealOwnerSteamIds) {
    await db.update(players).set({ roleId: ownerRoleId }).where(eq(players.steamId64, sid));
  }
  await db
    .update(panelMeta)
    .set({ firstOwnerClaimed: snapshotFirstOwnerClaimed })
    .where(eq(panelMeta.id, 1));
});

describe('claimFirstOwner', () => {
  it('claims Owner once and sets the singleton flag', async () => {
    const bridge = fakeBridge(false);
    const result = await claimFirstOwner(db, bridge, TEST_PLAYER_A);
    expect(result).toBe('claimed');

    const player = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_A));
    expect(player[0]?.roleId).toBe(ownerRoleId);

    const meta = await db.select().from(panelMeta).where(eq(panelMeta.id, 1));
    expect(meta[0]?.firstOwnerClaimed).toBe(true);

    expect(bridge.fileAtomicWrite).toHaveBeenCalledTimes(1);
  });

  it('returns already_claimed on second call (DB anchor)', async () => {
    await claimFirstOwner(db, fakeBridge(false), TEST_PLAYER_A);

    const bridge2 = fakeBridge(false);
    const result = await claimFirstOwner(db, bridge2, TEST_PLAYER_B);
    expect(result).toBe('already_claimed');

    const playerB = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_B));
    expect(playerB[0]?.roleId).toBeNull();
  });

  it('DB is authoritative — stale sentinel does not block a fresh claim', async () => {
    // Wedge scenario: panel was reinstalled (DB reset), but the sentinel
    // file from the previous install still exists on the host. The claim
    // must succeed against the fresh DB regardless of sentinel state.
    const bridge = fakeBridge(true);
    const result = await claimFirstOwner(db, bridge, TEST_PLAYER_A);
    expect(result).toBe('claimed');

    const meta = await db.select().from(panelMeta).where(eq(panelMeta.id, 1));
    expect(meta[0]?.firstOwnerClaimed).toBe(true);

    const player = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_A));
    expect(player[0]?.roleId).toBe(ownerRoleId);

    // After successful claim the sentinel is rewritten with the current owner.
    expect(bridge.fileAtomicWrite).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent calls — only one wins (advisory lock)', async () => {
    const bridge1 = fakeBridge(false);
    const bridge2 = fakeBridge(false);
    const [r1, r2] = await Promise.all([
      claimFirstOwner(db, bridge1, TEST_PLAYER_A),
      claimFirstOwner(db, bridge2, TEST_PLAYER_B),
    ]);
    const claimed = [r1, r2].filter((r) => r === 'claimed');
    const alreadyClaimed = [r1, r2].filter((r) => r === 'already_claimed');
    expect(claimed.length).toBe(1);
    expect(alreadyClaimed.length).toBe(1);
  });

  it('returns no_owner_role if Owner role somehow missing', async () => {
    await db
      .update(roles)
      .set({ isSystemRole: false })
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)));
    try {
      const result = await claimFirstOwner(db, fakeBridge(false), TEST_PLAYER_A);
      expect(result).toBe('no_owner_role');
    } finally {
      await db.update(roles).set({ isSystemRole: true }).where(eq(roles.name, 'Owner'));
    }
  });
});
