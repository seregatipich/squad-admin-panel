import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runPartitionTick } from '../src/index.js';

/**
 * Issue #6: `chat_messages`, `bonus_transactions` and `combat_events` got their
 * monthly partitions only once, from their migrations, and nothing rotated
 * them. Past that window every chat, bonus-ledger and VIP-grant insert fails
 * with "no partition of relation … found for row", and combat rows pile up in
 * `combat_events_default` — where they later block creating the month's
 * partition at all. The hourly tick must keep the current and next month
 * partitioned for all three, moving rows out of DEFAULT when it has to.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PLAYER_STEAM_ID = '76561190000060601';
const SERVER_SLUG = 'event-partition-issue-6';

let sql: ReturnType<typeof postgres>;
let playerId: string;
let serverId: string;

interface MonthlyTable {
  name: 'chat_messages' | 'bonus_transactions' | 'combat_events';
  insertAt: (at: Date) => Promise<void>;
  column: string;
}

const TABLES: MonthlyTable[] = [
  {
    name: 'chat_messages',
    column: 'sent_at',
    insertAt: async (at) => {
      await sql`
        INSERT INTO chat_messages (player_id, server_id, sent_at, scope, message)
        VALUES (${playerId}, ${serverId}, ${at}, 'all', 'issue-6')`;
    },
  },
  {
    name: 'bonus_transactions',
    column: 'created_at',
    insertAt: async (at) => {
      await sql`
        INSERT INTO bonus_transactions (player_id, amount, type, created_at)
        VALUES (${playerId}, 1, 'adjust', ${at})`;
    },
  },
  {
    name: 'combat_events',
    column: 'occurred_at',
    insertAt: async (at) => {
      await sql`
        INSERT INTO combat_events (event_type, server_id, occurred_at)
        VALUES ('death', ${serverId}, ${at})`;
    },
  },
];

function monthStart(offsetMonths: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
}

function partitionName(table: string, date: Date): string {
  return `${table}_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function partitionBound(table: string, partname: string): Promise<string | null> {
  const rows = (await sql`
    SELECT pg_get_expr(p.relpartbound, p.oid) AS bound
    FROM pg_inherits
    JOIN pg_class p  ON p.oid = inhrelid
    JOIN pg_class pp ON pp.oid = inhparent
    WHERE pp.relname = ${table} AND p.relname = ${partname}
  `) as unknown as { bound: string }[];
  return rows[0]?.bound ?? null;
}

async function tick(): Promise<void> {
  await runPartitionTick({ sql, diag: { emit: vi.fn(async () => undefined) } });
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  const [player] = await sql<{ id: string }[]>`
    INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized)
    VALUES (${PLAYER_STEAM_ID}, 'Issue 6', 'issue 6')
    ON CONFLICT (steam_id64) DO UPDATE SET canonical_name = EXCLUDED.canonical_name
    RETURNING id`;
  const [server] = await sql<{ id: string }[]>`
    INSERT INTO servers (id, display_name, slug)
    VALUES (gen_random_uuid(), 'Issue 6', ${SERVER_SLUG})
    RETURNING id`;
  playerId = player?.id as string;
  serverId = server?.id as string;
});

afterAll(async () => {
  if (!sql) return;
  await sql`DELETE FROM servers WHERE slug = ${SERVER_SLUG}`;
  await sql`DELETE FROM players WHERE steam_id64 = ${PLAYER_STEAM_ID}`;
  await sql.end();
});

describeIfDb('partition rotation for chat_messages, bonus_transactions and combat_events', () => {
  for (const table of TABLES) {
    it(`creates the current and next month ${table.name} partitions with UTC month bounds`, async () => {
      for (const offset of [0, 1]) {
        await sql.unsafe(`DROP TABLE IF EXISTS ${partitionName(table.name, monthStart(offset))};`);
      }

      await tick();

      for (const offset of [0, 1]) {
        const bound = await partitionBound(
          table.name,
          partitionName(table.name, monthStart(offset)),
        );
        expect(bound).toBe(
          `FOR VALUES FROM ('${monthStart(offset).toISOString().slice(0, 10)} 00:00:00+00') ` +
            `TO ('${monthStart(offset + 1)
              .toISOString()
              .slice(0, 10)} 00:00:00+00')`,
        );
      }
    });

    it(`accepts a ${table.name} insert for next month once the tick has run`, async () => {
      const nextName = partitionName(table.name, monthStart(1));
      await sql.unsafe(`DROP TABLE IF EXISTS ${nextName};`);

      await tick();

      const at = new Date(monthStart(1).getTime() + 86_400_000);
      await table.insertAt(at);
      const [row] = await sql.unsafe<{ part: string }[]>(
        `SELECT tableoid::regclass::text AS part FROM ${table.name} WHERE ${table.column} = $1`,
        [at.toISOString()],
      );
      expect(row?.part).toBe(nextName);
    });
  }

  it('moves rows parked in combat_events_default into the month partition it creates', async () => {
    const nextName = partitionName('combat_events', monthStart(1));
    await sql.unsafe(`DROP TABLE IF EXISTS ${nextName};`);
    const at = new Date(monthStart(1).getTime() + 2 * 86_400_000);
    await TABLES[2]?.insertAt(at);
    const [parked] = await sql<{ part: string }[]>`
      SELECT tableoid::regclass::text AS part FROM combat_events WHERE occurred_at = ${at}`;
    expect(parked?.part).toBe('combat_events_default');

    await tick();

    const [moved] = await sql<{ part: string }[]>`
      SELECT tableoid::regclass::text AS part FROM combat_events WHERE occurred_at = ${at}`;
    expect(moved?.part).toBe(nextName);
    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM combat_events_default
      WHERE occurred_at >= ${monthStart(1)} AND occurred_at < ${monthStart(2)}`;
    expect(left?.n).toBe(0);
  });

  it('never drops a partition of these tables — no retention policy is applied', async () => {
    const old = monthStart(-60);
    const oldName = partitionName('bonus_transactions', old);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${oldName} PARTITION OF bonus_transactions FOR VALUES FROM ('${old.toISOString().slice(0, 10)}') TO ('${monthStart(-59).toISOString().slice(0, 10)}');`,
    );

    await tick();

    expect(await partitionBound('bonus_transactions', oldName)).not.toBeNull();
    await sql.unsafe(`DROP TABLE IF EXISTS ${oldName};`);
  });
});
