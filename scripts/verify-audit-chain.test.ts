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

function runCli(databaseUrl: string | undefined): CliResult {
  const env = { ...process.env };
  if (databaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
  delete env.TEST_DATABASE_URL;
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
        ['trg_audit_log_ins', 'trg_audit_log_no_del', 'trg_audit_log_no_upd'],
      );
      await insertTwoRows(fixture.sql);
      await assert.rejects(
        fixture.sql`UPDATE audit_log SET action_type = 'tampered' WHERE id = 1`,
        /audit_log is append-only/,
      );
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
});
