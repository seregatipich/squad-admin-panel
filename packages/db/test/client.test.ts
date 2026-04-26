import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { players, roles, serverSettings, servers } from '../src/schema/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  pgsql = postgres(DATABASE_URL, { max: 5 });
  db = drizzle(pgsql, { schema });
});

afterAll(async () => {
  if (pgsql) await pgsql.end({ timeout: 5 });
});

describeIfDb('createDatabaseClient', () => {
  it('connects and runs a trivial query', async () => {
    const r = await db.execute(sql`SELECT 1::int AS x`);
    const row =
      (r as unknown as { rows: Array<{ x: number }> }).rows?.[0] ?? (r as Array<{ x: number }>)[0];
    expect(row?.x).toBe(1);
  });
});

describeIfDb('transactions', () => {
  it('commits on success', async () => {
    const id = uuidv7();
    const slug = `tx-commit-${id}`;

    await db.transaction(async (txdb) => {
      await txdb.insert(servers).values({
        id,
        displayName: 'TX Commit Test',
        slug,
        status: 'pending',
      });
    });

    const rows = await db.select().from(servers).where(eq(servers.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe(slug);

    await db.delete(servers).where(eq(servers.id, id));
  });

  it('rolls back on throw', async () => {
    const id = uuidv7();
    const slug = `tx-rollback-${id}`;

    await expect(
      db.transaction(async (txdb) => {
        await txdb.insert(servers).values({
          id,
          displayName: 'TX Rollback Test',
          slug,
          status: 'pending',
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const rows = await db.select().from(servers).where(eq(servers.id, id));
    expect(rows).toHaveLength(0);
  });
});

describeIfDb('advisory locks', () => {
  it('serializes two concurrent transactions on the same lock key', async () => {
    const timestamps: Array<{ tx: number; ts: number }> = [];

    const run = async (tx: number) => {
      await db.transaction(async (txdb) => {
        await txdb.execute(sql`SELECT pg_advisory_xact_lock(hashtext('test_lock_unit'))`);
        timestamps.push({ tx, ts: Date.now() });
        await new Promise<void>((r) => setTimeout(r, 100));
      });
    };

    await Promise.all([run(1), run(2)]);

    expect(timestamps).toHaveLength(2);
    const [first, second] = timestamps as [{ tx: number; ts: number }, { tx: number; ts: number }];
    expect(Math.abs(first.ts - second.ts)).toBeGreaterThanOrEqual(95);
  });
});

describeIfDb('FK constraints', () => {
  it('ON DELETE CASCADE removes server_settings when server deleted', async () => {
    const serverId = uuidv7();

    await db.insert(servers).values({
      id: serverId,
      displayName: 'Cascade Test Server',
      slug: `cascade-${serverId}`,
      status: 'pending',
    });

    await db.insert(serverSettings).values({
      serverId,
      installPath: `/var/lib/squad-panel/configs/${serverId}`,
      gamePort: 7787,
      queryPort: 27165,
      beaconPort: 15000,
      rconPort: 21114,
    });

    const settingsBefore = await db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.serverId, serverId));
    expect(settingsBefore).toHaveLength(1);

    await db.delete(servers).where(eq(servers.id, serverId));

    const settingsAfter = await db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.serverId, serverId));
    expect(settingsAfter).toHaveLength(0);
  });

  it('ON DELETE SET NULL preserves player but clears role_id when role deleted', async () => {
    const roleId = uuidv7();
    const roleName = `test-role-${roleId}`;
    const steamId = BigInt('7656119800000000') + BigInt(Math.floor(Math.random() * 1_000_000));

    await db.insert(roles).values({
      id: roleId,
      name: roleName,
      isSystemRole: false,
    });

    await db.insert(players).values({
      steamId64: steamId,
      canonicalName: 'Test Player',
      canonicalNameNormalized: 'test player',
      roleId,
    });

    const playerBefore = await db.select().from(players).where(eq(players.steamId64, steamId));
    expect(playerBefore[0]?.roleId).toBe(roleId);

    await db.delete(roles).where(eq(roles.id, roleId));

    const playerAfter = await db.select().from(players).where(eq(players.steamId64, steamId));
    expect(playerAfter).toHaveLength(1);
    expect(playerAfter[0]?.roleId).toBeNull();

    await db.delete(players).where(eq(players.steamId64, steamId));
  });
});
