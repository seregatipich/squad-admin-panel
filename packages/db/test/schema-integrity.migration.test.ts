import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from './helpers/describe-if.js';
import {
  createIsolatedPackageTestDatabase,
  MIGRATIONS_FOLDER,
} from './helpers/isolated-database.js';

/**
 * Migrations 0132-0135 (issues #77, #1089, #1084): the append-only tables'
 * foreign keys, the audit_log id order, config_versions parent integrity,
 * redundant and missing indexes, the ban-appeal tracking token at rest and the
 * events NOTIFY trigger. The v2 hash form and TRUNCATE guards are covered by
 * audit-integrity.test.ts. Runs against this worker's migrated clone.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const STEAM_ID_BASE = 76561190077000000n;
let steamSeq = 0n;
function nextSteamId(): string {
  steamSeq += 1n;
  return String(STEAM_ID_BASE + steamSeq);
}

let sql: postgres.Sql;

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 4, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function insertPlayer(): Promise<string> {
  const steam = nextSteamId();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized)
    VALUES (${steam}, ${`integrity ${steam}`}, ${`integrity ${steam}`})
    RETURNING id`;
  if (!row) throw new Error('player insert returned no row');
  return row.id;
}

async function insertServer(): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO servers (id, display_name, slug)
    VALUES (${id}, 'integrity test server', ${`integrity-${id}`})`;
  return id;
}

async function pgErrorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describeIfDb('append-only tables keep their actor references (RESTRICT, not SET NULL)', () => {
  it('refuses to delete a player referenced by audit_log with a foreign-key violation', async () => {
    const playerId = await insertPlayer();
    await sql`
      INSERT INTO audit_log (actor_kind, actor_player_id, action_type, row_hash)
      VALUES ('steam', ${playerId}, 'integrity.fk', '\\x00')`;

    const code = await pgErrorCode(() => sql`DELETE FROM players WHERE id = ${playerId}`);

    expect(code).toBe('23503');
  });

  it('refuses to delete an API token referenced by audit_log with a foreign-key violation', async () => {
    const playerId = await insertPlayer();
    const tokenId = randomUUID();
    await sql`
      INSERT INTO player_api_tokens (id, player_id, name, token_hash)
      VALUES (${tokenId}, ${playerId}, 'integrity', ${`hash-${tokenId}`})`;
    await sql`
      INSERT INTO audit_log (actor_kind, actor_player_id, actor_token_id, action_type, row_hash)
      VALUES ('steam', ${playerId}, ${tokenId}, 'integrity.fk-token', '\\x00')`;

    const code = await pgErrorCode(() => sql`DELETE FROM player_api_tokens WHERE id = ${tokenId}`);

    expect(code).toBe('23503');
  });

  it('refuses to delete a player who authored a config version with a foreign-key violation', async () => {
    const playerId = await insertPlayer();
    const serverId = await insertServer();
    await sql`
      INSERT INTO config_versions (server_id, filename, content, sha256, author_player_id)
      VALUES (${serverId}, 'Server.cfg', 'x', '\\x00', ${playerId})`;

    const code = await pgErrorCode(() => sql`DELETE FROM players WHERE id = ${playerId}`);

    expect(code).toBe('23503');
  });

  it('declares every actor foreign key as NO ACTION', async () => {
    const rows = await sql<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE contype = 'f'
        AND conname IN ('audit_log_actor_player_id_fk', 'audit_log_actor_token_id_fkey',
                        'config_versions_author_player_id_fk')
      ORDER BY conname`;
    expect(rows).toEqual([
      { conname: 'audit_log_actor_player_id_fk', confdeltype: 'a' },
      { conname: 'audit_log_actor_token_id_fkey', confdeltype: 'a' },
      { conname: 'config_versions_author_player_id_fk', confdeltype: 'a' },
    ]);
  });
});

describeIfDb('audit_log hash chain', () => {
  async function insertAudit(label: string, explicitId?: bigint): Promise<bigint> {
    const [row] = explicitId
      ? await sql<{ id: string }[]>`
          INSERT INTO audit_log (id, actor_kind, actor_system_label, action_type, row_hash)
          VALUES (${String(explicitId)}, 'system', 'integrity', ${label}, '\\x00')
          RETURNING id::text AS id`
      : await sql<{ id: string }[]>`
          INSERT INTO audit_log (actor_kind, actor_system_label, action_type, row_hash)
          VALUES ('system', 'integrity', ${label}, '\\x00')
          RETURNING id::text AS id`;
    if (!row) throw new Error('audit insert returned no row');
    return BigInt(row.id);
  }

  it('stays linear in id order when an inserter took its id before a later one took the lock', async () => {
    const first = await insertAudit('integrity.chain.first');
    // A concurrent session that drew its id from the sequence but has not
    // reached the trigger's advisory lock yet.
    const [{ reserved }] = await sql<{ reserved: string }[]>`
      SELECT nextval(pg_get_serial_sequence('audit_log', 'id'))::text AS reserved`;
    const overtaking = await insertAudit('integrity.chain.overtaking');
    const late = await insertAudit('integrity.chain.late', BigInt(reserved));

    expect(late).toBeGreaterThan(overtaking);
    // Each insert draws exactly one sequence value (no column default is
    // consumed before the trigger assigns the id).
    expect([BigInt(reserved), overtaking, late]).toEqual([first + 1n, first + 2n, first + 3n]);
    const breaks = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM (
        SELECT id, prev_hash, lag(row_hash) OVER (ORDER BY id) AS expected
        FROM audit_log WHERE id >= ${String(first)}
      ) chain
      WHERE id > ${String(first)} AND prev_hash IS DISTINCT FROM expected`;
    expect(breaks).toEqual([]);
  });
});

describeIfDb('config_versions parent chain', () => {
  it('rejects a parent_version_id that points at no version', async () => {
    const serverId = await insertServer();
    const code = await pgErrorCode(
      () => sql`
        INSERT INTO config_versions (server_id, filename, content, sha256, author_label, parent_version_id)
        VALUES (${serverId}, 'Server.cfg', 'x', '\\x00', 'integrity', ${randomUUID()})`,
    );
    expect(code).toBe('23503');
  });

  it('still lets a server delete cascade through its own version chain', async () => {
    const serverId = await insertServer();
    const [root] = await sql<{ id: string }[]>`
      INSERT INTO config_versions (server_id, filename, content, sha256, author_label)
      VALUES (${serverId}, 'Server.cfg', 'v1', '\\x01', 'integrity') RETURNING id`;
    await sql`
      INSERT INTO config_versions (server_id, filename, content, sha256, author_label, parent_version_id)
      VALUES (${serverId}, 'Server.cfg', 'v2', '\\x02', 'integrity', ${root?.id ?? null})`;

    await sql`DELETE FROM servers WHERE id = ${serverId}`;

    const [{ left }] = await sql<{ left: number }[]>`
      SELECT count(*)::int AS left FROM config_versions WHERE server_id = ${serverId}`;
    expect(left).toBe(0);
  });
});

describeIfDb('indexes', () => {
  it('drops indexes that duplicate a leading unique/primary-key column or index a lone boolean', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'matches_server_started_idx', 'game_votes_server_started_idx',
        'role_squad_permissions_role_idx', 'player_kit_time_player_id_idx',
        'media_links_media_idx', 'issue_links_issue_idx', 'automation_rules_enabled_idx')`;
    expect(rows).toEqual([]);

    const covering = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'matches_server_started_key', 'game_votes_server_started_key',
        'role_squad_permissions_pk', 'player_kit_time_pk',
        'media_links_media_entity_key', 'issue_links_issue_entity_key')
      ORDER BY indexname`;
    expect(covering.map((row) => row.indexname)).toEqual([
      'game_votes_server_started_key',
      'issue_links_issue_entity_key',
      'matches_server_started_key',
      'media_links_media_entity_key',
      'player_kit_time_pk',
      'role_squad_permissions_pk',
    ]);
  });

  it('indexes only the schedule rows the scheduler still reads', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('rotation_schedule_pending_idx', 'seed_schedule_active_idx')
      ORDER BY indexname`;
    expect(rows.map((row) => row.indexname)).toEqual([
      'rotation_schedule_pending_idx',
      'seed_schedule_active_idx',
    ]);
    expect(rows[0]?.indexdef).toContain('WHERE (enabled AND (last_executed_at IS NULL))');
    expect(rows[1]?.indexdef).toContain(
      'WHERE (enabled AND ((recurrence IS NOT NULL) OR (last_executed_at IS NULL)))',
    );
  });
});

describeIfDb('ban_appeals tracking token at rest', () => {
  it('keeps only the sha256 of a plaintext token written by the previous release', async () => {
    const token = `integrity-${randomUUID()}`;
    const [row] = await sql<{ tracking_token: string | null; tracking_token_hash: string }[]>`
      INSERT INTO ban_appeals (steam_id64, body, tracking_token, status)
      VALUES (${nextSteamId()}, 'appeal', ${token}, 'rejected')
      RETURNING tracking_token, tracking_token_hash`;

    expect(row).toEqual({
      tracking_token: null,
      tracking_token_hash: createHash('sha256').update(token).digest('hex'),
    });
  });

  it('requires a hash and keeps it unique', async () => {
    const hash = randomUUID().replaceAll('-', '').padEnd(64, '0');
    await sql`
      INSERT INTO ban_appeals (steam_id64, body, tracking_token_hash, status)
      VALUES (${nextSteamId()}, 'appeal', ${hash}, 'rejected')`;
    expect(
      await pgErrorCode(
        () => sql`
          INSERT INTO ban_appeals (steam_id64, body, tracking_token_hash, status)
          VALUES (${nextSteamId()}, 'appeal', ${hash}, 'rejected')`,
      ),
    ).toBe('23505');
    expect(
      await pgErrorCode(
        () => sql`
          INSERT INTO ban_appeals (steam_id64, body, status)
          VALUES (${nextSteamId()}, 'appeal', 'rejected')`,
      ),
    ).toBe('23502');
  });
});

describeIfDb('events_appended NOTIFY', () => {
  it('fires once per statement and announces each distinct (server_id, kind)', async () => {
    const [trigger] = await sql<{ row_level: boolean }[]>`
      SELECT (tgtype & 1) = 1 AS row_level FROM pg_trigger
      WHERE tgname = 'trg_events_notify_appended' AND tgrelid = 'events'::regclass`;
    expect(trigger?.row_level).toBe(false);

    const serverId = await insertServer();
    const received: string[] = [];
    const listener = postgres(DATABASE_URL ?? '', { max: 1, onnotice: () => undefined });
    try {
      await listener.listen('events_appended', (payload) => received.push(payload));
      await sql`
        INSERT INTO events (event_id, server_id, occurred_at, kind, payload)
        SELECT gen_random_uuid(), ${serverId}, '2026-06-15T00:00:00Z',
               CASE WHEN n % 2 = 0 THEN 'integrity.a' ELSE 'integrity.b' END, '{}'::jsonb
        FROM generate_series(1, 20) AS n`;
      for (let i = 0; i < 50 && received.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await listener.end({ timeout: 5 });
    }

    const mine = received
      .map((raw) => JSON.parse(raw) as { server_id: string; kind: string })
      .filter((event) => event.server_id === serverId)
      .sort((a, b) => a.kind.localeCompare(b.kind));
    expect(mine).toEqual([
      { server_id: serverId, kind: 'integrity.a' },
      { server_id: serverId, kind: 'integrity.b' },
    ]);
  });
});

describeIfDb('upgrading a populated 0118 database', () => {
  it('keeps the existing audit chain verifiable, hashes stored appeal tokens and continues the chain', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_integrity_upgrade', {
      throughMigration: '0118_clan_members_release_disbanded',
    });
    // created_at::text is hashed in UTC; pin the reading session the same way.
    const db = postgres(isolated.url, {
      max: 1,
      onnotice: () => undefined,
      connection: { TimeZone: 'UTC' },
    });
    try {
      for (const action of ['pre.one', 'pre.two']) {
        await db`
          INSERT INTO audit_log (actor_kind, actor_system_label, action_type, context, row_hash)
          VALUES ('system', 'upgrade', ${action}, '{"k":1}'::jsonb, '\\x00')`;
      }
      await db`
        INSERT INTO ban_appeals (steam_id64, body, tracking_token)
        VALUES (${nextSteamId()}, 'pre-upgrade appeal', 'pre-upgrade-token')`;

      await migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });

      await db`
        INSERT INTO audit_log (actor_kind, actor_system_label, action_type, row_hash)
        VALUES ('system', 'upgrade', 'post.one', '\\x00')`;
      const chain = await db<
        { id: string; version: number; v1_ok: boolean | null; linked: boolean }[]
      >`
        SELECT id::text AS id,
               hash_version AS version,
               CASE WHEN hash_version = 1 THEN row_hash = digest(
                 COALESCE(prev_hash, ''::bytea) || convert_to(
                   action_type || '|' || COALESCE(target_type, '') || '|' ||
                   COALESCE(target_id, '') || '|' || context::text || '|' || created_at::text,
                   'UTF8'),
                 'sha256') END AS v1_ok,
               prev_hash IS NOT DISTINCT FROM lag(row_hash) OVER (ORDER BY id) AS linked
        FROM audit_log ORDER BY id`;
      expect(chain.map((row) => row.id)).toEqual(['1', '2', '3']);
      // Existing rows keep the v1 form and still verify; the new row is v2
      // and continues the chain from the last v1 row.
      expect(chain.map((row) => row.version)).toEqual([1, 1, 2]);
      expect(chain.filter((row) => row.version === 1).every((row) => row.v1_ok)).toBe(true);
      expect(chain.every((row) => row.linked)).toBe(true);

      const [appeal] = await db<{ tracking_token: string | null; tracking_token_hash: string }[]>`
        SELECT tracking_token, tracking_token_hash FROM ban_appeals`;
      expect(appeal).toEqual({
        tracking_token: null,
        tracking_token_hash: createHash('sha256').update('pre-upgrade-token').digest('hex'),
      });
    } finally {
      await db.end({ timeout: 5 });
      await isolated.drop();
    }
  }, 120_000);
});
