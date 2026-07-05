import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { combatEvents } from '../src/schema/combat-events.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const perfDescribe = DATABASE_URL && process.env.COMBAT_EVENTS_PERF ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMBAT_SQL = readFileSync(path.resolve(__dirname, '../sql/combat-events.sql'), 'utf-8');

const SERVER_1 = '000000c1-0000-4000-8000-000000000001';
const SERVER_2 = '000000c2-0000-4000-8000-000000000002';
const VICTIM = '000000d1-0000-4000-9000-000000000001';
const ATTACKER = '000000d2-0000-4000-9000-000000000002';
const NULL_STEAM_PLAYER = '000000d3-0000-4000-9000-000000000003';
const PLAYERS: [string, string, bigint | null][] = [
  [VICTIM, 'Victim', 76561190000000001n],
  [ATTACKER, 'Attacker', 76561190000000002n],
  [NULL_STEAM_PLAYER, 'GhostNoSteam', null],
];

let sql: ReturnType<typeof postgres>;
let monthStart: Date;
let currentPart: string;
let prevPart: string;
let nextPart: string;

function planText(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  // Isolate the combat_events DDL in a dedicated schema: `test:cov` runs the
  // @squad/db and @squad/api vitest processes concurrently against the same
  // database, so dropping/recreating the shared public.combat_events here would
  // race the api combat-events suite (reusePublicSchema). FK targets (players,
  // servers) stay in public via the search_path fallback.
  await sql.unsafe('DROP SCHEMA IF EXISTS combat_events_dbtest CASCADE');
  await sql.unsafe('CREATE SCHEMA combat_events_dbtest');
  await sql.unsafe('SET search_path TO combat_events_dbtest, public');
  await sql.unsafe(COMBAT_SQL);

  await sql`
    INSERT INTO servers (id, display_name, slug) VALUES
      (${SERVER_1}, 'combat-srv-1', 'combat-srv-1'),
      (${SERVER_2}, 'combat-srv-2', 'combat-srv-2')
    ON CONFLICT (id) DO NOTHING
  `;
  for (const [id, name, steamId64] of PLAYERS) {
    await sql`
      INSERT INTO players (id, canonical_name, canonical_name_normalized, steam_id64)
      VALUES (${id}, ${name}, ${name.toLowerCase()}, ${steamId64})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  const [bounds] = await sql<
    { month_start: Date; current_part: string; prev_part: string; next_part: string }[]
  >`
    SELECT date_trunc('month', now()) AS month_start,
           'combat_events_' || to_char(now(), 'YYYY_MM') AS current_part,
           'combat_events_' || to_char(now() - interval '1 month', 'YYYY_MM') AS prev_part,
           'combat_events_' || to_char(now() + interval '1 month', 'YYYY_MM') AS next_part
  `;
  monthStart = bounds.month_start;
  currentPart = bounds.current_part;
  prevPart = bounds.prev_part;
  nextPart = bounds.next_part;

  await sql.unsafe(`
    INSERT INTO combat_events
      (event_type, server_id, victim_player_id, attacker_player_id, weapon, damage, is_teamkill, occurred_at)
    SELECT
      (ARRAY['death','damage','wound','revive'])[1 + (g % 4)],
      (ARRAY['${SERVER_1}','${SERVER_2}']::uuid[])[1 + (g % 2)],
      (ARRAY['${VICTIM}','${ATTACKER}','${NULL_STEAM_PLAYER}']::uuid[])[1 + (g % 3)],
      CASE WHEN g % 6 = 0 THEN NULL
           ELSE (ARRAY['${VICTIM}','${ATTACKER}','${NULL_STEAM_PLAYER}']::uuid[])[1 + ((g * 2) % 3)] END,
      'BP_Weapon_' || (g % 8),
      (g % 120)::numeric,
      (g % 5 = 0),
      date_trunc('month', now())
        + ((g % 60) - 15 || ' days')::interval
        + ((g % 3600) || ' seconds')::interval
    FROM generate_series(1, 4000) g
  `);
  await sql.unsafe('ANALYZE combat_events');
}, 60_000);

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe('DROP SCHEMA IF EXISTS combat_events_dbtest CASCADE');
  await sql`DELETE FROM players WHERE id = ANY(${PLAYERS.map(([id]) => id)})`;
  await sql`DELETE FROM servers WHERE id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql.end({ timeout: 5 });
});

describeIfDb('combat_events table shape', () => {
  it('is monthly RANGE-partitioned on occurred_at', async () => {
    const [meta] = await sql`
      SELECT partstrat, pg_get_partkeydef(partrelid) AS keydef
      FROM pg_partitioned_table
      WHERE partrelid = 'combat_events'::regclass
    `;
    expect(meta.partstrat).toBe('r');
    expect(meta.keydef).toBe('RANGE (occurred_at)');
  });

  it('has a DEFAULT partition plus bootstrap month partitions', async () => {
    const rows = await sql<{ part: string; expr: string }[]>`
      SELECT inhrelid::regclass::text AS part,
             pg_get_expr(c.relpartbound, c.oid) AS expr
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'combat_events'::regclass
    `;
    const parts = new Map(rows.map((r) => [r.part, r.expr]));
    expect(parts.has('combat_events_default')).toBe(true);
    expect(parts.get('combat_events_default')).toBe('DEFAULT');
    expect(parts.has(currentPart)).toBe(true);
    expect(parts.get(currentPart)).toMatch(/FOR VALUES FROM/);
  });

  it('carries all required indexes including the partial teamkill and BRIN indexes', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'combat_events' AND schemaname = 'combat_events_dbtest'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.has('combat_events_server_occurred_idx')).toBe(true);
    expect(byName.has('combat_events_attacker_occurred_idx')).toBe(true);
    expect(byName.has('combat_events_victim_occurred_idx')).toBe(true);
    expect(byName.get('combat_events_teamkill_victim_idx')).toMatch(/WHERE is_teamkill/);
    expect(byName.get('combat_events_occurred_at_brin_idx')).toMatch(/USING brin/);
  });

  it('routes an insert into the occurred_at monthly partition', async () => {
    const at = new Date(monthStart.getTime() + 5 * 86_400_000);
    const [row] = await sql`
      INSERT INTO combat_events (event_type, server_id, victim_player_id, occurred_at)
      VALUES ('death', ${SERVER_1}, ${VICTIM}, ${at})
      RETURNING tableoid::regclass::text AS partition, id
    `;
    expect(row.partition).toBe(currentPart);
    expect(typeof row.id).toBe('string');
    await sql`DELETE FROM combat_events WHERE id = ${row.id}`;
  });

  it('rejects an unknown event_type via the check constraint', async () => {
    await expect(
      sql`INSERT INTO combat_events (event_type, server_id, victim_player_id, occurred_at)
          VALUES ('capture', ${SERVER_1}, ${VICTIM}, now())`,
    ).rejects.toThrow(/combat_events_event_type_chk/);
  });
});

describeIfDb('combat_events foreign keys', () => {
  it('accepts a victim/attacker whose steam_id64 is NULL (UUID-only linkage)', async () => {
    const [ghost] = await sql<{ steam_id64: string | null }[]>`
      SELECT steam_id64 FROM players WHERE id = ${NULL_STEAM_PLAYER}
    `;
    expect(ghost.steam_id64).toBeNull();
    const [row] = await sql`
      INSERT INTO combat_events (event_type, server_id, victim_player_id, attacker_player_id, occurred_at)
      VALUES ('death', ${SERVER_1}, ${NULL_STEAM_PLAYER}, ${NULL_STEAM_PLAYER}, ${monthStart})
      RETURNING id
    `;
    expect(row.id).toBeDefined();
    await sql`DELETE FROM combat_events WHERE id = ${row.id}`;
  });

  it('rejects a victim_player_id that does not reference an existing player', async () => {
    await expect(
      sql`INSERT INTO combat_events (event_type, server_id, victim_player_id, occurred_at)
          VALUES ('death', ${SERVER_1}, '000000ff-0000-4000-9000-0000000000ff', ${monthStart})`,
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('accepts a NULL victim_player_id for a vehicle_destroyed event (DOSSIER-1)', async () => {
    const [row] = await sql`
      INSERT INTO combat_events (event_type, server_id, victim_player_id, victim_vehicle, occurred_at)
      VALUES ('vehicle_destroyed', ${SERVER_1}, NULL, 'T72B3', ${monthStart})
      RETURNING id, victim_vehicle
    `;
    expect(row.id).toBeDefined();
    expect(row.victim_vehicle).toBe('T72B3');
    await sql`DELETE FROM combat_events WHERE id = ${row.id}`;
  });

  it('inserts and reads back through the drizzle table definition', async () => {
    const db = (await import('drizzle-orm/postgres-js')).drizzle(sql);
    const inserted = await db
      .insert(combatEvents)
      .values({
        eventType: 'wound',
        serverId: SERVER_2,
        victimPlayerId: VICTIM,
        attackerPlayerId: ATTACKER,
        weapon: 'BP_Rifle',
        damage: '42.5',
        isTeamkill: true,
        occurredAt: monthStart,
      })
      .returning({ id: combatEvents.id, isTeamkill: combatEvents.isTeamkill });
    expect(inserted[0].isTeamkill).toBe(true);
    await sql`DELETE FROM combat_events WHERE id = ${inserted[0].id}`;
  });
});

describeIfDb('combat_events query plans (fixture scale)', () => {
  it("victim's events for a month prune to the month partition and use an index", async () => {
    await sql.unsafe('SET enable_seqscan = off');
    const plan = planText(
      await sql.unsafe(`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT * FROM combat_events
        WHERE victim_player_id = '${VICTIM}'
          AND occurred_at >= date_trunc('month', now())
          AND occurred_at < date_trunc('month', now()) + interval '1 month'
        ORDER BY occurred_at DESC
        LIMIT 200
      `),
    );
    await sql.unsafe('RESET enable_seqscan');
    expect(plan).toContain(currentPart);
    expect(plan).not.toContain(prevPart);
    expect(plan).not.toContain(nextPart);
    expect(plan).not.toContain('Seq Scan');
    expect(plan).toMatch(/Index Scan|Bitmap Index Scan/);
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 'NaN');
    expect(ms).toBeLessThan(300);
  });

  it('server teamkills for a week prune to the month partition and use an index', async () => {
    await sql.unsafe('SET enable_seqscan = off');
    const plan = planText(
      await sql.unsafe(`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT * FROM combat_events
        WHERE server_id = '${SERVER_1}'
          AND is_teamkill
          AND occurred_at >= date_trunc('month', now())
          AND occurred_at < date_trunc('month', now()) + interval '7 days'
        ORDER BY occurred_at DESC
      `),
    );
    await sql.unsafe('RESET enable_seqscan');
    expect(plan).toContain(currentPart);
    expect(plan).not.toContain(prevPart);
    expect(plan).not.toContain(nextPart);
    expect(plan).not.toContain('Seq Scan');
    expect(plan).toMatch(/Index Scan|Bitmap Index Scan/);
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 'NaN');
    expect(ms).toBeLessThan(300);
  });
});

perfDescribe('combat_events query plans (1,000,000 rows)', () => {
  const POOL_SERVERS = 4;
  const POOL_PLAYERS = 200;
  const perfServer = '000000c1-0000-4000-8000-000000000001';
  let perfVictim: string;

  beforeAll(async () => {
    perfVictim = `000000d1-0000-4000-9000-${String(POOL_PLAYERS).padStart(12, '0')}`;
    await sql.unsafe('TRUNCATE combat_events');
    await sql.unsafe(`
      INSERT INTO servers (id, display_name, slug)
      SELECT ('000000c1-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'perf-srv-' || g, 'perf-srv-' || g
      FROM generate_series(1, ${POOL_SERVERS}) g
      ON CONFLICT (id) DO NOTHING
    `);
    await sql.unsafe(`
      INSERT INTO players (id, canonical_name, canonical_name_normalized)
      SELECT ('000000d1-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'perf-p-' || g, 'perf-p-' || g
      FROM generate_series(1, ${POOL_PLAYERS}) g
      ON CONFLICT (id) DO NOTHING
    `);
    await sql.unsafe(
      'DROP INDEX IF EXISTS combat_events_server_occurred_idx, combat_events_attacker_occurred_idx, combat_events_victim_occurred_idx, combat_events_teamkill_victim_idx, combat_events_occurred_at_brin_idx',
    );
    await sql.unsafe('SET session_replication_role = replica');
    await sql.unsafe(`
      INSERT INTO combat_events
        (event_type, server_id, victim_player_id, attacker_player_id, weapon, damage, is_teamkill, occurred_at)
      SELECT
        (ARRAY['death','damage','wound','revive'])[1 + (g % 4)],
        ('000000c1-0000-4000-8000-' || lpad((1 + (g % ${POOL_SERVERS}))::text, 12, '0'))::uuid,
        ('000000d1-0000-4000-9000-' || lpad((1 + (g % ${POOL_PLAYERS}))::text, 12, '0'))::uuid,
        CASE WHEN g % 7 = 0 THEN NULL
             ELSE ('000000d1-0000-4000-9000-' || lpad((1 + ((g * 3) % ${POOL_PLAYERS}))::text, 12, '0'))::uuid END,
        'BP_Weapon_' || (g % 20),
        (g % 100)::numeric,
        (g % 50 = 0),
        date_trunc('month', now()) - interval '15 days'
          + ((g % 90) || ' days')::interval
          + ((g % 86400) || ' seconds')::interval
      FROM generate_series(1, 1000000) g
    `);
    await sql.unsafe('SET session_replication_role = default');
    await sql.unsafe(
      'CREATE INDEX combat_events_server_occurred_idx ON combat_events (server_id, occurred_at DESC)',
    );
    await sql.unsafe(
      'CREATE INDEX combat_events_attacker_occurred_idx ON combat_events (attacker_player_id, occurred_at DESC)',
    );
    await sql.unsafe(
      'CREATE INDEX combat_events_victim_occurred_idx ON combat_events (victim_player_id, occurred_at DESC)',
    );
    await sql.unsafe(
      'CREATE INDEX combat_events_teamkill_victim_idx ON combat_events (victim_player_id, occurred_at DESC) WHERE is_teamkill',
    );
    await sql.unsafe(
      'CREATE INDEX combat_events_occurred_at_brin_idx ON combat_events USING brin (occurred_at) WITH (pages_per_range = 32)',
    );
    await sql.unsafe('ANALYZE combat_events');
  }, 600_000);

  async function explainWarm(query: string): Promise<string> {
    await sql.unsafe(`EXPLAIN (ANALYZE, FORMAT TEXT) ${query}`);
    return planText(await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`));
  }

  it("victim's events for a month: partition pruning + index scan under 300ms", async () => {
    const plan = await explainWarm(`
      SELECT * FROM combat_events
      WHERE victim_player_id = '${perfVictim}'
        AND occurred_at >= date_trunc('month', now())
        AND occurred_at < date_trunc('month', now()) + interval '1 month'
      ORDER BY occurred_at DESC
      LIMIT 200
    `);
    expect(plan).toContain(currentPart);
    expect(plan).not.toContain(prevPart);
    expect(plan).toMatch(/Index Scan|Bitmap Index Scan/);
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 'NaN');
    expect(ms).toBeLessThan(300);
  }, 600_000);

  it('server teamkills for a week: partition pruning + index scan under 300ms', async () => {
    const plan = await explainWarm(`
      SELECT * FROM combat_events
      WHERE server_id = '${perfServer}'
        AND is_teamkill
        AND occurred_at >= date_trunc('month', now())
        AND occurred_at < date_trunc('month', now()) + interval '7 days'
      ORDER BY occurred_at DESC
    `);
    expect(plan).toContain(currentPart);
    expect(plan).not.toContain(prevPart);
    expect(plan).toMatch(/Index Scan|Bitmap Index Scan/);
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 'NaN');
    expect(ms).toBeLessThan(300);
  }, 600_000);
});
