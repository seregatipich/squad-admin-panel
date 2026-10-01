import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { pruneProcessedEvents } from '../src/index.js';

// regression (#62): processed_events was never pruned and grew by one row per
// persisted event. Rows past the events retention window are now deleted.
const DATABASE_URL = process.env.DATABASE_URL;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  if (sql) await sql.end();
});

describeIfDb('pruneProcessedEvents', () => {
  it('deletes markers older than the events retention window and keeps recent ones', async () => {
    const staleId = randomUUID();
    const recentId = randomUUID();
    await sql`
      INSERT INTO processed_events (event_id, group_name, processed_at) VALUES
        (${staleId}, 'prune-test', now() - interval '25 months'),
        (${recentId}, 'prune-test', now() - interval '1 day')
    `;

    await pruneProcessedEvents(sql);

    const remaining = (await sql`
      SELECT event_id FROM processed_events WHERE group_name = 'prune-test'
    `) as unknown as { event_id: string }[];
    expect(remaining.map((row) => row.event_id)).toEqual([recentId]);
    await sql`DELETE FROM processed_events WHERE group_name = 'prune-test'`;
  });
});
