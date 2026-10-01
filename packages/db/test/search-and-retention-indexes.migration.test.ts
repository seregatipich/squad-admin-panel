import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from './helpers/describe-if.js';

/**
 * Issue #52: nickname search is `LIKE '%…%'`, which a plain B-tree cannot
 * serve, reporter lookups had no index, and `processed_events` kept an index
 * nothing queried while its retention delete had none to use.
 */

const DATABASE_URL = process.env.DATABASE_URL;

let sql: ReturnType<typeof postgres>;

async function indexDef(name: string): Promise<string | null> {
  const [row] = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}`;
  return row?.indexdef ?? null;
}

/**
 * Plans `query` with sequential scans disabled and the B-tree index on the
 * same column hidden, inside a transaction that is always rolled back: on the
 * near-empty test tables the planner would otherwise pick a full B-tree scan,
 * and the point is that the trigram index can serve the leading wildcard.
 */
async function planWithoutBtree(query: string, btreeIndex: string): Promise<string> {
  let plan = '';
  const rollback = new Error('rollback');
  await sql
    .begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      await tx.unsafe(`DROP INDEX ${btreeIndex}`);
      const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${query}`);
      plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      throw rollback;
    })
    .catch((err: unknown) => {
      if (err !== rollback) throw err;
    });
  return plan;
}

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describeIfDb('nickname substring search indexes (#52 findings 1128, 1252)', () => {
  it('indexes player_name_history.name_normalized with a trigram GIN index', async () => {
    expect(await indexDef('player_name_history_name_normalized_trgm_idx')).toMatch(
      /USING gin \(name_normalized gin_trgm_ops\)/,
    );
  });

  it('indexes players.canonical_name_normalized with a trigram GIN index', async () => {
    expect(await indexDef('players_canonical_name_normalized_trgm_idx')).toMatch(
      /USING gin \(canonical_name_normalized gin_trgm_ops\)/,
    );
  });

  it('serves a leading-wildcard LIKE from the trigram indexes', async () => {
    expect(
      await planWithoutBtree(
        `SELECT 1 FROM player_name_history WHERE name_normalized LIKE '%abc%'`,
        'player_name_history_name_normalized_idx',
      ),
    ).toContain('Bitmap Index Scan on player_name_history_name_normalized_trgm_idx');
    expect(
      await planWithoutBtree(
        `SELECT 1 FROM players WHERE canonical_name_normalized LIKE '%abc%'`,
        'players_canonical_name_normalized_idx',
      ),
    ).toContain('Bitmap Index Scan on players_canonical_name_normalized_trgm_idx');
  });
});

describeIfDb('player_reports person indexes (#52 finding 1130)', () => {
  it('indexes reports by reporter and creation time', async () => {
    expect(await indexDef('player_reports_reporter_created_idx')).toMatch(
      /\(reporter_player_id, created_at\)/,
    );
  });

  it('indexes the handler foreign key its ON DELETE SET NULL scans', async () => {
    expect(await indexDef('player_reports_handler_player_idx')).toMatch(/\(handler_player_id\)/);
  });
});

describeIfDb('processed_events indexes (#52 finding 1122)', () => {
  it('drops the group index no query used', async () => {
    expect(await indexDef('processed_events_group_idx')).toBeNull();
  });

  it('indexes processed_at for the retention delete', async () => {
    expect(await indexDef('processed_events_processed_at_idx')).toMatch(/\(processed_at\)/);
  });
});
