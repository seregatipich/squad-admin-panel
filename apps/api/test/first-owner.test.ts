import * as schema from '@squad/db/schema';
import { panelMeta, players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFirstOwner } from '../src/lib/first-owner.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import { createIsolatedSchema } from './integration/isolated-db.js';

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

const TEST_PLAYER_A = testSteamId(10);
const TEST_PLAYER_B = testSteamId(11);

let pgsql: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ownerRoleId: string;
let isolated: Awaited<ReturnType<typeof createIsolatedSchema>> | null = null;
// Populated for TEST_PLAYER_A and TEST_PLAYER_B by the beforeEach insert below;
// every `playerId(...)` call in this suite looks up one of those two ids.
const playerIds = new Map<bigint, string>();

function playerId(steamId64: bigint): string {
  const id = playerIds.get(steamId64);
  if (!id) throw new Error(`Missing player fixture for ${steamId64}`);
  return id;
}

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// Each test runs against its own fresh, isolated database — a real "who is
// the sole Owner" invariant (migration 0107) makes the old approach of
// masking/restoring the shared installation's live Owners unsafe: this suite
// intentionally strips and reassigns Owner status, which the guard trigger
// must be free to reject or allow based on this suite's own fixtures only.
beforeEach(async () => {
  if (!DATABASE_URL) return;
  isolated = await createIsolatedSchema();
  pgsql = postgres(isolated.url);
  db = drizzle(pgsql, { schema });

  const ownerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  ownerRoleId = ownerRows[0]?.id ?? '';
  if (!ownerRoleId) throw new Error('Owner role fixture is missing');

  for (const sid of [TEST_PLAYER_A, TEST_PLAYER_B]) {
    const stub = `Test ${String(sid).slice(-4)}`;
    const rows = await db
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
      })
      .returning({ id: players.id });
    const inserted = rows[0];
    if (!inserted) throw new Error(`insert did not return a row for steamId64=${sid}`);
    playerIds.set(sid, inserted.id);
  }
});

afterEach(async () => {
  if (!DATABASE_URL) return;
  const currentSql = pgsql;
  const currentDatabase = isolated;
  pgsql = null;
  isolated = null;
  playerIds.clear();
  if (currentSql) await currentSql.end({ timeout: 5 }).catch(() => undefined);
  if (currentDatabase) await currentDatabase.drop();
});

describeIfDb('claimFirstOwner', () => {
  it('claims Owner once and sets the singleton flag', async () => {
    const bridge = fakeBridge(false);
    const result = await claimFirstOwner(db, bridge, playerId(TEST_PLAYER_A), TEST_PLAYER_A);
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
    await claimFirstOwner(db, fakeBridge(false), playerId(TEST_PLAYER_A), TEST_PLAYER_A);

    const bridge2 = fakeBridge(false);
    const result = await claimFirstOwner(db, bridge2, playerId(TEST_PLAYER_B), TEST_PLAYER_B);
    expect(result).toBe('already_claimed');

    const playerB = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_B));
    expect(playerB[0]?.roleId).toBeNull();
  });

  // regression: stale /var/lib/squad-panel/.first-owner-claimed sentinel blocked claim path
  it('DB is authoritative — stale sentinel does not block a fresh claim (regression)', async () => {
    const bridge = fakeBridge(true);
    const result = await claimFirstOwner(db, bridge, playerId(TEST_PLAYER_A), TEST_PLAYER_A);
    expect(result).toBe('claimed');

    const meta = await db.select().from(panelMeta).where(eq(panelMeta.id, 1));
    expect(meta[0]?.firstOwnerClaimed).toBe(true);

    const player = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_A));
    expect(player[0]?.roleId).toBe(ownerRoleId);

    expect(bridge.fileAtomicWrite).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent calls — only one wins (advisory lock)', async () => {
    const bridge1 = fakeBridge(false);
    const bridge2 = fakeBridge(false);
    const [r1, r2] = await Promise.all([
      claimFirstOwner(db, bridge1, playerId(TEST_PLAYER_A), TEST_PLAYER_A),
      claimFirstOwner(db, bridge2, playerId(TEST_PLAYER_B), TEST_PLAYER_B),
    ]);
    const claimed = [r1, r2].filter((r) => r === 'claimed');
    const alreadyClaimed = [r1, r2].filter((r) => r === 'already_claimed');
    expect(claimed.length).toBe(1);
    expect(alreadyClaimed.length).toBe(1);
  });

  it('returns no_owner_role if Owner role somehow missing', async () => {
    // Migration 0107 makes this corruption unreachable through normal writes.
    // Disable only the identity trigger in this disposable database to retain
    // coverage of the defensive fallback for pre-migration/corrupt installs.
    const sqlClient = pgsql;
    if (!sqlClient) throw new Error('PostgreSQL fixture is missing');
    await sqlClient.unsafe('ALTER TABLE roles DISABLE TRIGGER trg_roles_owner_identity_guard');
    try {
      await db
        .update(roles)
        .set({ isSystemRole: false })
        .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)));
      const result = await claimFirstOwner(
        db,
        fakeBridge(false),
        playerId(TEST_PLAYER_A),
        TEST_PLAYER_A,
      );
      expect(result).toBe('no_owner_role');
    } finally {
      await db.update(roles).set({ isSystemRole: true }).where(eq(roles.name, 'Owner'));
      await sqlClient.unsafe('ALTER TABLE roles ENABLE TRIGGER trg_roles_owner_identity_guard');
    }
  });
});
