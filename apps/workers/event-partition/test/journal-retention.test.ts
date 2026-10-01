import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { runPartitionTick } from '../src/index.js';

/**
 * Issue #77: the journal tables below had no retention at all and grew for
 * ever. The hourly tick now prunes what is past its window and keeps what is
 * fresh or still referenced.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const PLAYER_STEAM_ID = '76561190000077701';

let sql: ReturnType<typeof postgres>;
let serverId: string;
let playerId: string;

const OLD = "now() - interval '400 days'";
const RECENT = "now() - interval '1 day'";

async function ids(table: string, column = 'id'): Promise<string[]> {
  const rows = await sql.unsafe<{ id: string }[]>(`SELECT ${column}::text AS id FROM ${table}`);
  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
  serverId = randomUUID();
  await sql`
    INSERT INTO servers (id, display_name, slug)
    VALUES (${serverId}, 'retention test server', ${`retention-${serverId}`})`;
  const [player] = await sql<{ id: string }[]>`
    INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized)
    VALUES (${PLAYER_STEAM_ID}, 'Retention Player', 'retention player')
    RETURNING id`;
  if (!player) throw new Error('player insert returned no row');
  playerId = player.id;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describeIfDb('journal retention in the hourly tick', () => {
  it('prunes expired journal rows, keeps fresh and referenced ones, and clears old appeal IPs', async () => {
    const ruleId = randomUUID();
    await sql`INSERT INTO alert_rules (id, name, type) VALUES (${ruleId}, 'retention', 'custom')`;
    const alert = {
      oldDelivered: randomUUID(),
      oldUndelivered: randomUUID(),
      ancientUndelivered: randomUUID(),
      oldReferenced: randomUUID(),
      recent: randomUUID(),
    };
    await sql.unsafe(`
      INSERT INTO alert_events (id, rule_id, triggered_at, payload, severity, delivered) VALUES
        ('${alert.oldDelivered}', '${ruleId}', now() - interval '100 days', '{}', 'info', true),
        ('${alert.oldUndelivered}', '${ruleId}', now() - interval '100 days', '{}', 'info', false),
        ('${alert.ancientUndelivered}', '${ruleId}', ${OLD}, '{}', 'info', false),
        ('${alert.oldReferenced}', '${ruleId}', ${OLD}, '{}', 'info', true),
        ('${alert.recent}', '${ruleId}', ${RECENT}, '{}', 'info', true)`);
    await sql`
      INSERT INTO expiry_notifications
        (player_id, role_id, expires_at, window_days, recipient, alert_event_id)
      VALUES (${playerId}, (SELECT id FROM roles LIMIT 1), now(), 7, 'admin', ${alert.oldReferenced})`;

    const outbox = { oldRelayed: randomUUID(), oldPending: randomUUID(), recent: randomUUID() };
    await sql.unsafe(`
      INSERT INTO admins_cfg_sync_outbox (id, server_id, payload, created_at, relayed_at) VALUES
        ('${outbox.oldRelayed}', '${serverId}', '{}', ${OLD}, ${OLD}),
        ('${outbox.oldPending}', '${serverId}', '{}', ${OLD}, NULL),
        ('${outbox.recent}', '${serverId}', '{}', ${RECENT}, ${RECENT})`);

    const taskId = randomUUID();
    await sql`
      INSERT INTO scheduled_tasks (id, server_id, name, task_type, recurrence)
      VALUES (${taskId}, ${serverId}, 'retention', 'broadcast', '0 * * * *')`;
    const run = { old: randomUUID(), recent: randomUUID() };
    await sql.unsafe(`
      INSERT INTO scheduled_task_runs (id, task_id, executed_at, status) VALUES
        ('${run.old}', '${taskId}', ${OLD}, 'executed'),
        ('${run.recent}', '${taskId}', ${RECENT}, 'executed')`);

    const invocation = { old: randomUUID(), recent: randomUUID() };
    await sql.unsafe(`
      INSERT INTO chat_command_invocations (id, server_id, command, args, created_at) VALUES
        ('${invocation.old}', '${serverId}', 'stats', '', ${OLD}),
        ('${invocation.recent}', '${serverId}', 'stats', '', ${RECENT})`);

    const automationRuleId = randomUUID();
    await sql`
      INSERT INTO automation_rules (id, name, condition_type, action_type)
      VALUES (${automationRuleId}, 'retention', 'chat_keyword', 'notify_admin')`;
    const automationRun = { old: randomUUID(), recent: randomUUID() };
    await sql.unsafe(`
      INSERT INTO automation_runs (id, rule_id, fired_at, matched, status) VALUES
        ('${automationRun.old}', '${automationRuleId}', ${OLD}, '{}', 'executed'),
        ('${automationRun.recent}', '${automationRuleId}', ${RECENT}, '{}', 'executed')`);

    const token = {
      expired: randomUUID(),
      used: randomUUID(),
      referenced: randomUUID(),
      live: randomUUID(),
    };
    await sql.unsafe(`
      INSERT INTO media_upload_tokens (id, token_hash, expires_at, used_at, max_size_bytes) VALUES
        ('${token.expired}', 'h-${token.expired}', ${OLD}, NULL, 1),
        ('${token.used}', 'h-${token.used}', now() + interval '1 day', ${OLD}, 1),
        ('${token.referenced}', 'h-${token.referenced}', ${OLD}, ${OLD}, 1),
        ('${token.live}', 'h-${token.live}', now() + interval '1 day', NULL, 1)`);
    await sql`
      INSERT INTO media_files
        (id, kind, original_filename, mime_type, size_bytes, sha256, storage_path, upload_token_id)
      VALUES (${randomUUID()}, 'image', 'a.png', 'image/png', 1, ${`sha-${token.referenced}`},
              'a/a.png', ${token.referenced})`;

    const appeal = {
      decidedLongAgo: randomUUID(),
      submittedLongAgo: randomUUID(),
      fresh: randomUUID(),
    };
    await sql.unsafe(`
      INSERT INTO ban_appeals
        (id, steam_id64, body, status, tracking_token_hash, submitter_ip, created_at, decided_at)
      VALUES
        ('${appeal.decidedLongAgo}', 76561190000077711, 'appeal', 'rejected', 'r1-${appeal.decidedLongAgo}',
         '203.0.113.1', now() - interval '60 days', now() - interval '31 days'),
        ('${appeal.submittedLongAgo}', 76561190000077712, 'appeal', 'rejected', 'r2-${appeal.submittedLongAgo}',
         '203.0.113.2', now() - interval '91 days', NULL),
        ('${appeal.fresh}', 76561190000077713, 'appeal', 'rejected', 'r3-${appeal.fresh}',
         '203.0.113.3', now() - interval '10 days', now() - interval '5 days')`);

    await runPartitionTick({ sql, diag: { emit: vi.fn(async () => undefined) } });

    expect(await ids('alert_events')).toEqual(
      [alert.oldUndelivered, alert.oldReferenced, alert.recent].sort(),
    );
    expect(await ids('admins_cfg_sync_outbox')).toEqual([outbox.oldPending, outbox.recent].sort());
    expect(await ids('scheduled_task_runs')).toEqual([run.recent]);
    expect(await ids('chat_command_invocations')).toEqual([invocation.recent]);
    expect(await ids('automation_runs')).toEqual([automationRun.recent]);
    expect(await ids('media_upload_tokens')).toEqual([token.referenced, token.live].sort());
    const ips = await sql<{ id: string; ip: string | null }[]>`
      SELECT id::text AS id, host(submitter_ip) AS ip FROM ban_appeals
      WHERE id IN (${appeal.decidedLongAgo}, ${appeal.submittedLongAgo}, ${appeal.fresh})
      ORDER BY created_at`;
    expect(Object.fromEntries(ips.map((row) => [row.id, row.ip]))).toEqual({
      [appeal.decidedLongAgo]: null,
      [appeal.submittedLongAgo]: null,
      [appeal.fresh]: '203.0.113.3',
    });
  });

  it('works off a backlog larger than one batch in a single tick', async () => {
    await sql`DELETE FROM chat_command_invocations WHERE server_id = ${serverId}`;
    await sql.unsafe(`
      INSERT INTO chat_command_invocations (server_id, command, args, created_at)
      SELECT '${serverId}', 'stats', '', ${OLD} FROM generate_series(1, 5001)`);

    await runPartitionTick({ sql, diag: { emit: vi.fn(async () => undefined) } });

    const [{ left }] = await sql<{ left: number }[]>`
      SELECT count(*)::int AS left FROM chat_command_invocations WHERE server_id = ${serverId}`;
    expect(left).toBe(0);
  });
});
