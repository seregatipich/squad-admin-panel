import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0136 (issue #78, findings 1117/1124/1125/1136/1141): indexes
 * nothing reads are gone, and `balancer_proposals` carries a partial unique
 * index so at most one snapshot per (server_id, mode) is `open`.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let sql: postgres.Sql;

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function indexNames(): Promise<Set<string>> {
  const rows = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`;
  return new Set(rows.map((row) => row.indexname));
}

describeIfDb('migration 0136 index cleanup', () => {
  it.each([
    'external_bans_source_id_idx',
    'reporter_stats_trusted_idx',
    'reporter_stats_spam_idx',
    'sessions_last_activity_idx',
    'media_upload_tokens_expires_at_idx',
    'diagnostic_events_server_ts_idx',
    'diagnostic_events_kind_ts_idx',
  ])('drops the unused index %s', async (name) => {
    expect((await indexNames()).has(name)).toBe(false);
  });

  it('keeps the indexes that serve real queries', async () => {
    const names = await indexNames();
    for (const name of [
      'external_bans_dedup_key',
      'diagnostic_events_ts_idx',
      'media_upload_tokens_token_hash_key',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('allows one open balancer snapshot per (server_id, mode) only', async () => {
    const [index] = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'balancer_proposals_open_key' AND schemaname = current_schema()`;
    expect(index?.indexdef).toMatch(/UNIQUE/);
    expect(index?.indexdef).toMatch(/\(server_id, mode\)/);
    expect(index?.indexdef).toMatch(/status = 'open'/);
  });
});
