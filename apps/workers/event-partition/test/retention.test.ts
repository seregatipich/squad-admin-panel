import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import {
  PROCESSED_EVENTS_RETENTION_MONTHS,
  runPartitionTick,
  SCHEDULED_TASK_RUNS_MAX_PER_TASK,
  SCHEDULED_TASK_RUNS_RETENTION_DAYS,
} from '../src/index.js';

/**
 * Issue #52: `processed_events` gained a row for every persisted event and
 * `scheduled_task_runs` one per scheduler attempt (every 30 s for a task whose
 * dispatch keeps failing), and nothing ever deleted either. The hourly tick
 * must bound both.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const SERVER_SLUG = 'event-partition-issue-52';
const DAY_MS = 86_400_000;

let sql: ReturnType<typeof postgres>;
let serverId: string;

async function tick(): Promise<void> {
  await runPartitionTick({ sql, diag: { emit: vi.fn(async () => undefined) } });
}

async function createTask(): Promise<string> {
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO scheduled_tasks (server_id, name, task_type, recurrence)
    VALUES (${serverId}, 'issue-52', 'broadcast', '* * * * *')
    RETURNING id`;
  return task?.id as string;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  const [server] = await sql<{ id: string }[]>`
    INSERT INTO servers (id, display_name, slug)
    VALUES (gen_random_uuid(), 'Issue 52', ${SERVER_SLUG})
    RETURNING id`;
  serverId = server?.id as string;
});

afterAll(async () => {
  if (!sql) return;
  await sql`DELETE FROM servers WHERE slug = ${SERVER_SLUG}`;
  await sql.end();
});

describeIfDb('processed_events retention', () => {
  it('deletes claims older than the events retention window and keeps newer ones', async () => {
    const expired = randomUUID();
    const kept = randomUUID();
    const now = new Date();
    const beyond = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - PROCESSED_EVENTS_RETENTION_MONTHS - 1, 1),
    );
    const within = new Date(now.getTime() - 30 * DAY_MS);
    await sql`
      INSERT INTO processed_events (event_id, group_name, processed_at)
      VALUES (${expired}, 'issue-52', ${beyond}), (${kept}, 'issue-52', ${within})`;

    await tick();

    const rows = await sql<{ event_id: string }[]>`
      SELECT event_id FROM processed_events WHERE event_id IN (${expired}, ${kept})`;
    expect(rows.map((r) => r.event_id)).toEqual([kept]);
  });
});

describeIfDb('scheduled_task_runs retention', () => {
  it('deletes runs older than the retention window and keeps recent ones', async () => {
    const taskId = await createTask();
    const now = Date.now();
    await sql`
      INSERT INTO scheduled_task_runs (task_id, executed_at, status)
      VALUES
        (${taskId}, ${new Date(now - (SCHEDULED_TASK_RUNS_RETENTION_DAYS + 1) * DAY_MS)}, 'failed'),
        (${taskId}, ${new Date(now - DAY_MS)}, 'executed')`;

    await tick();

    const rows = await sql<{ status: string }[]>`
      SELECT status FROM scheduled_task_runs WHERE task_id = ${taskId}`;
    expect(rows.map((r) => r.status)).toEqual(['executed']);
  });

  it('keeps only the newest runs of a task that keeps failing', async () => {
    const taskId = await createTask();
    const otherTaskId = await createTask();
    const extra = 5;
    // One failed attempt every 30 s, newest first: a task whose dispatch never succeeds.
    await sql`
      INSERT INTO scheduled_task_runs (task_id, executed_at, status)
      SELECT ${taskId}, now() - make_interval(secs => n * 30), 'failed'
      FROM generate_series(0, ${SCHEDULED_TASK_RUNS_MAX_PER_TASK + extra - 1}) AS n`;
    await sql`
      INSERT INTO scheduled_task_runs (task_id, executed_at, status)
      VALUES (${otherTaskId}, now(), 'executed')`;

    await tick();

    const [kept] = await sql<{ count: number; oldest: Date }[]>`
      SELECT count(*)::int AS count, min(executed_at) AS oldest
      FROM scheduled_task_runs WHERE task_id = ${taskId}`;
    expect(kept?.count).toBe(SCHEDULED_TASK_RUNS_MAX_PER_TASK);
    const expectedOldestAgoMs = (SCHEDULED_TASK_RUNS_MAX_PER_TASK - 1) * 30_000;
    expect(Date.now() - (kept?.oldest as Date).getTime()).toBeLessThan(
      expectedOldestAgoMs + 60_000,
    );
    const [other] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM scheduled_task_runs WHERE task_id = ${otherTaskId}`;
    expect(other?.count).toBe(1);
  });
});
