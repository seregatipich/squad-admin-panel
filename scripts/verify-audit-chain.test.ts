import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'scripts/verify-audit-chain.ts');
const TSX = path.join(REPOSITORY_ROOT, 'node_modules/.bin/tsx');
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const createdDatabases: string[] = [];

if (process.env.CI && !DATABASE_URL) {
  throw new Error('CI must provide TEST_DATABASE_URL or DATABASE_URL for audit-chain tests');
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let administrator: ReturnType<typeof postgres>;
let templateDatabase: string;

function databaseUrl(database: string): string {
  const url = new URL(DATABASE_URL as string);
  url.pathname = `/${database}`;
  url.searchParams.delete('options');
  return url.toString();
}

function runCli(databaseUrl: string | undefined, batchSize?: number): CliResult {
  const env = { ...process.env };
  if (databaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
  delete env.TEST_DATABASE_URL;
  if (batchSize !== undefined) env.AUDIT_CHAIN_BATCH_SIZE = String(batchSize);
  else delete env.AUDIT_CHAIN_BATCH_SIZE;
  const result = spawnSync(TSX, [SCRIPT], {
    cwd: REPOSITORY_ROOT,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function migrateDatabase(url: string): void {
  const result = spawnSync('pnpm', ['--filter', '@squad/db', 'migrate'], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `database migration failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function auditDatabase(): Promise<{
  url: string;
  sql: ReturnType<typeof postgres>;
}> {
  const name = `audit_chain_test_${process.pid}_${createdDatabases.length}_${Date.now()}`;
  await administrator.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${templateDatabase}"`);
  createdDatabases.push(name);
  const url = databaseUrl(name);
  return { url, sql: postgres(url, { max: 1, prepare: false }) };
}

async function insertTwoRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    INSERT INTO audit_log (
      created_at, actor_kind, actor_system_label, action_type, target_type, target_id, context
    )
    VALUES (
      ${new Date('2026-08-13T10:00:00.000Z')},
      ${'system'},
      ${'audit-chain-test'},
      ${'server.create'},
      ${'server'},
      ${'server-one'},
      ${sql.json({ requestId: 'first' })}
    )
  `;
  await sql`
    INSERT INTO audit_log (
      created_at, actor_kind, actor_system_label, action_type, target_type, target_id, context
    )
    VALUES (
      ${new Date('2026-08-13T10:01:00.000Z')},
      ${'system'},
      ${'audit-chain-test'},
      ${'role.member.add'},
      ${'role'},
      ${'role-one'},
      ${sql.json({ requestId: 'second', nested: { safe: true } })}
    )
  `;
}

/** Inserts `n` sequential rows via the real trigger (real, trigger-computed hashes). */
async function insertRows(sql: ReturnType<typeof postgres>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      INSERT INTO audit_log (
        created_at, actor_kind, actor_system_label, action_type, target_type, target_id, context
      )
      VALUES (
        ${new Date(Date.UTC(2026, 7, 13, 10, 0, i))},
        ${'system'},
        ${'audit-chain-test'},
        ${'server.create'},
        ${'server'},
        ${`server-${i}`},
        ${sql.json({ seq: i })}
      )
    `;
  }
}

describe('verify-audit-chain CLI configuration boundary', () => {
  it('uses exit 2 for missing configuration and database dependency failure', () => {
    const missing = runCli(undefined);
    assert.equal(missing.status, 2);
    assert.equal(missing.stdout, '');
    assert.equal(missing.stderr, 'DATABASE_URL is required\n');

    const unavailable = runCli(
      'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable?connect_timeout=1',
    );
    assert.equal(unavailable.status, 2);
    assert.equal(unavailable.stdout, '');
    assert.match(unavailable.stderr, /^fatal:/);
  });
});

describe('verify-audit-chain CLI with migrated database', { skip: !DATABASE_URL }, () => {
  before(async () => {
    templateDatabase = `audit_chain_template_${process.pid}_${Date.now()}`;
    administrator = postgres(databaseUrl('postgres'), {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    await administrator.unsafe(`CREATE DATABASE "${templateDatabase}"`);
    createdDatabases.push(templateDatabase);
    migrateDatabase(databaseUrl(templateDatabase));
  });

  after(async () => {
    for (const database of createdDatabases.reverse()) {
      await administrator.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    await administrator.end({ timeout: 5 });
  });

  it('returns 0 for an empty chain', async () => {
    const fixture = await auditDatabase();
    try {
      const result = runCli(fixture.url);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'ok: audit chain intact (0 rows)\n');
      assert.equal(result.stderr, '');
    } finally {
      await fixture.sql.end({ timeout: 5 });
    }
  });

  it('accepts trigger-generated hashes and enforces append-only triggers', async () => {
    const fixture = await auditDatabase();
    try {
      const triggers = await fixture.sql<{ name: string }[]>`
        SELECT tgname AS name
        FROM pg_trigger
        WHERE tgrelid = 'audit_log'::regclass
          AND NOT tgisinternal
        ORDER BY tgname
      `;
      assert.deepEqual(
        triggers.map((trigger) => trigger.name),
        [
          'trg_audit_log_ins',
          'trg_audit_log_no_del',
          'trg_audit_log_no_truncate',
          'trg_audit_log_no_upd',
        ],
      );
      await insertTwoRows(fixture.sql);
      await assert.rejects(
        fixture.sql`UPDATE audit_log SET action_type = 'tampered' WHERE id = 1`,
        /audit_log is append-only/,
      );
      await assert.rejects(fixture.sql`TRUNCATE audit_log`, /audit_log is append-only/);
      const result = runCli(fixture.url);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'ok: audit chain intact (2 rows)\n');
    } finally {
      await fixture.sql.end({ timeout: 5 });
    }
  });

  it('returns 1 at the exact row whose row hash was tampered', async () => {
    const fixture = await auditDatabase();
    try {
      await insertTwoRows(fixture.sql);
      await fixture.sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_upd`;
      try {
        await fixture.sql`
          UPDATE audit_log
          SET row_hash = decode(repeat('ff', 32), 'hex')
          WHERE id = 1
        `;
      } finally {
        await fixture.sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_upd`;
      }
      const result = runCli(fixture.url);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Chain break at id=1: row_hash mismatch/m);
      assert.match(result.stderr, /^ {2}verified 0 row\(s\) before the break$/m);
      assert.doesNotMatch(result.stderr, /id=2/);
    } finally {
      await fixture.sql.end({ timeout: 5 });
    }
  });

  it('returns 1 at the exact row whose predecessor link was broken', async () => {
    const fixture = await auditDatabase();
    try {
      await insertTwoRows(fixture.sql);
      await fixture.sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_upd`;
      try {
        await fixture.sql`
          UPDATE audit_log
          SET prev_hash = decode(repeat('ab', 32), 'hex')
          WHERE id = 2
        `;
      } finally {
        await fixture.sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_upd`;
      }
      const result = runCli(fixture.url);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Chain break at id=2: prev_hash mismatch/m);
      assert.match(result.stderr, /^ {2}verified 1 row\(s\) before the break$/m);
    } finally {
      await fixture.sql.end({ timeout: 5 });
    }
  });

  /**
   * #49: the bigserial default used to hand out the id before the trigger took
   * the chain lock, so a writer that got its id first but the lock second was
   * chained after a higher id. The verifier walks by id and reported a false
   * "Chain break". The session holding advisory lock 42 parks the first
   * insert between id allocation and the trigger to force that interleaving.
   */
  it('keeps id order equal to chain order when concurrent inserts race for the lock', async () => {
    const fixture = await auditDatabase();
    const gate = postgres(fixture.url, { max: 1, prepare: false });
    const slow = postgres(fixture.url, { max: 1, prepare: false });
    try {
      await gate`SELECT pg_advisory_lock(42)`;
      const slowInsert = slow`
        INSERT INTO audit_log (
          created_at, actor_kind, actor_system_label, action_type, context
        )
        VALUES (
          ${new Date('2026-08-13T10:00:00.000Z')},
          ${'system'},
          ${'audit-chain-test'},
          ${'slow.writer'},
          (SELECT '{}'::jsonb FROM (SELECT pg_advisory_lock(42)) AS parked)
        )
      `.execute();
      for (let attempt = 0; attempt < 100; attempt++) {
        const [waiting] = await fixture.sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM pg_locks
          WHERE locktype = 'advisory' AND objid = 42 AND NOT granted
        `;
        if (waiting?.count === '1') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await fixture.sql`
        INSERT INTO audit_log (
          created_at, actor_kind, actor_system_label, action_type, context
        )
        VALUES (
          ${new Date('2026-08-13T10:00:01.000Z')},
          ${'system'},
          ${'audit-chain-test'},
          ${'fast.writer'},
          ${fixture.sql.json({})}
        )
      `;
      await gate`SELECT pg_advisory_unlock(42)`;
      await slowInsert;

      const rows = await fixture.sql<{ action_type: string }[]>`
        SELECT action_type FROM audit_log ORDER BY id ASC
      `;
      assert.deepEqual(
        rows.map((row) => row.action_type),
        ['fast.writer', 'slow.writer'],
      );
      const result = runCli(fixture.url);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'ok: audit chain intact (2 rows)\n');
    } finally {
      await gate.end({ timeout: 5 });
      await slow.end({ timeout: 5 });
      await fixture.sql.end({ timeout: 5 });
    }
  });

  // #1216: verify-audit-chain used to SELECT the whole table into memory in
  // one query. These force the keyset-pagination path with a tiny page size
  // (AUDIT_CHAIN_BATCH_SIZE) instead of inserting thousands of rows.
  it('verifies an intact chain that spans multiple pages', async () => {
    const fixture = await auditDatabase();
    try {
      await insertRows(fixture.sql, 7);
      const result = runCli(fixture.url, 3);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'ok: audit chain intact (7 rows)\n');
    } finally {
      await fixture.sql.end({ timeout: 5 });
    }
  });

  it('detects a break in a later page, with the checked count carried across pages', async () => {
    const fixture = await auditDatabase();
    try {
      await insertRows(fixture.sql, 7);
      await fixture.sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_upd`;
      try {
        // Row 5 falls in the second page of three (rows 4-6) at batch size 3.
        await fixture.sql`
          UPDATE audit_log
          SET row_hash = decode(repeat('ff', 32), 'hex')
          WHERE id = 5
        `;
      } finally {
        await fixture.sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_upd`;
      }
      const result = runCli(fixture.url, 3);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Chain break at id=5: row_hash mismatch/m);
      assert.match(result.stderr, /^ {2}verified 4 row\(s\) before the break$/m);
    } finally {
      await fixture.sql.end({ timeout: 5 });
    }
  });
});
