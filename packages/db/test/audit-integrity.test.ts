import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from './helpers/describe-if.js';

/**
 * Issue #50 (#1251/#1064): the audit_log hash chain covered only
 * action/target/context/created_at::text, and neither audit_log nor
 * config_versions blocked TRUNCATE (row-level deny triggers never fire on it).
 */

const DATABASE_URL = process.env.DATABASE_URL;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** Runs `statement` in a transaction that is always rolled back. */
async function inRolledBackTransaction(statement: string): Promise<void> {
  const rollback = new Error('rollback');
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(statement);
      throw rollback;
    });
  } catch (err) {
    if (err === rollback) return;
    throw err;
  }
}

/** Independent re-implementation of the v2 canonical form (length-prefixed fields). */
function v2Field(value: string | null): string {
  return value === null ? '|-' : `|${Buffer.byteLength(value, 'utf-8')}:${value}`;
}

describeIfDb('audit_log / config_versions integrity guards', () => {
  it('rejects TRUNCATE audit_log', async () => {
    await expect(inRolledBackTransaction('TRUNCATE audit_log')).rejects.toThrow(
      /audit_log is append-only/,
    );
  });

  it('rejects TRUNCATE config_versions, even with CASCADE', async () => {
    await expect(inRolledBackTransaction('TRUNCATE config_versions CASCADE')).rejects.toThrow(
      /config_versions is append-only/,
    );
  });

  it('hashes new rows with the v2 canonical form covering actor, snapshots and status', async () => {
    await sql`SET TIME ZONE 'Asia/Tokyo'`;
    try {
      const [row] = await sql<
        {
          id: string;
          hash_version: number;
          prev_hash_hex: string | null;
          row_hash_hex: string;
        }[]
      >`
        INSERT INTO audit_log (
          created_at, actor_kind, actor_system_label, actor_ip, action_type,
          target_type, target_id, before_snapshot, after_snapshot, context,
          status_code, duration_ms, row_hash
        )
        VALUES (
          '2026-08-13T10:00:00.123456Z', 'system', 'integrity|test', '10.0.0.7',
          'server.update', 'server', 'srv-ü', ${sql.json({ a: 1 })}, ${sql.json({ a: 2 })},
          ${sql.json({ requestId: 'r1' })}, 200, 12, ''::bytea
        )
        RETURNING id::text AS id, hash_version,
          encode(prev_hash, 'hex') AS prev_hash_hex, encode(row_hash, 'hex') AS row_hash_hex
      `;
      if (!row) throw new Error('insert returned no row');
      expect(row.hash_version).toBe(2);

      const canonical = [
        'v2',
        v2Field(row.id),
        v2Field('2026-08-13T10:00:00.123456Z'),
        v2Field('system'),
        v2Field(null),
        v2Field(null),
        v2Field('integrity|test'),
        v2Field('10.0.0.7/32'),
        v2Field('server.update'),
        v2Field('server'),
        v2Field('srv-ü'),
        v2Field('{"a": 1}'),
        v2Field('{"a": 2}'),
        v2Field('{"requestId": "r1"}'),
        v2Field('200'),
        v2Field('12'),
      ].join('');
      const prev = row.prev_hash_hex ? Buffer.from(row.prev_hash_hex, 'hex') : Buffer.alloc(0);
      const expected = createHash('sha256')
        .update(Buffer.concat([prev, Buffer.from(canonical, 'utf-8')]))
        .digest('hex');
      expect(row.row_hash_hex).toBe(expected);
    } finally {
      await sql`RESET TIME ZONE`;
    }
  });
});
