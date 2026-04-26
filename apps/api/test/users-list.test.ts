import * as schema from '@squad/db/schema';
import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let viewerRoleId: string;

const TEST_PLAYER_WITH_ROLE = testSteamId(700001);
const TEST_PLAYER_WITHOUT_ROLE = testSteamId(700002);

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not set');
  sql = postgres(dbUrl, { max: 3, onnotice: () => undefined });
  db = drizzle(sql, { schema });

  const viewerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Viewer'), eq(roles.isSystemRole, false)))
    .limit(1);
  if (!viewerRows[0]) throw new Error('Viewer role not found — run migrations first');
  viewerRoleId = viewerRows[0].id;
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  for (const [sid, roleId] of [
    [TEST_PLAYER_WITH_ROLE, viewerRoleId],
    [TEST_PLAYER_WITHOUT_ROLE, null],
  ] as const) {
    const stub = `TestUser${String(sid).slice(-4)}`;
    await db
      .insert(players)
      .values({
        steamId64: sid,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: roleId ?? null,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId: roleId ?? null } });
  }
});

afterEach(async () => {
  for (const sid of [TEST_PLAYER_WITH_ROLE, TEST_PLAYER_WITHOUT_ROLE]) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
    await db.delete(players).where(eq(players.steamId64, sid));
  }
});

describe('users list — role_id NOT NULL filter', () => {
  it('players with role_id set appear in joined query', async () => {
    const usersWithRole = await db
      .select({
        steamId64: players.steamId64,
        roleId: players.roleId,
        roleName: roles.name,
      })
      .from(players)
      .innerJoin(roles, eq(roles.id, players.roleId))
      .where(and(eq(players.steamId64, TEST_PLAYER_WITH_ROLE)));

    expect(usersWithRole.length).toBe(1);
    expect(usersWithRole[0]?.roleId).toBe(viewerRoleId);
    expect(usersWithRole[0]?.roleName).toBe('Viewer');
  });

  it('players without role_id do not appear in joined query', async () => {
    const usersWithRole = await db
      .select({ steamId64: players.steamId64 })
      .from(players)
      .innerJoin(roles, eq(roles.id, players.roleId))
      .where(eq(players.steamId64, TEST_PLAYER_WITHOUT_ROLE));

    expect(usersWithRole.length).toBe(0);
  });

  it('both players exist in the players table', async () => {
    const all = await db
      .select({ steamId64: players.steamId64, roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_WITH_ROLE));
    expect(all[0]?.roleId).toBe(viewerRoleId);

    const noRole = await db
      .select({ steamId64: players.steamId64, roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_WITHOUT_ROLE));
    expect(noRole[0]?.roleId).toBeNull();
  });
});
