import { createHash } from 'node:crypto';
import { fc, test } from '@fast-check/vitest';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { createIsolatedSchema, runMigrations } from '../integration/harness.js';

/**
 * Independent reference of the v2 canonical form hashed by `audit_log_append()`
 * (migration 0135): `'v2'` + every column as a `|<bytes>:<value>` field, `|-`
 * for NULL.
 */
function computeRowHash(prevHashHex: string | null, row: RawRow): string {
  const prev = prevHashHex ? Buffer.from(prevHashHex, 'hex') : Buffer.alloc(0);
  const field = (v: string | null) => (v === null ? '|-' : `|${Buffer.byteLength(v)}:${v}`);
  const canonical = `v2${[
    row.id,
    row.created_at_utc,
    row.actor_kind,
    row.actor_player_id,
    row.actor_token_id,
    row.actor_system_label,
    row.actor_ip,
    row.action_type,
    row.target_type,
    row.target_id,
    row.before_snapshot_text,
    row.after_snapshot_text,
    row.context_text,
    row.status_code_text,
    row.duration_ms_text,
  ]
    .map(field)
    .join('')}`;
  return createHash('sha256')
    .update(Buffer.concat([prev, Buffer.from(canonical, 'utf-8')]))
    .digest('hex');
}

const safeString = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes('\x00'));

const safeContextGen = fc
  .array(fc.tuple(safeString, fc.oneof(safeString, fc.integer())), { maxLength: 8 })
  .map((entries) => Object.fromEntries(entries));

const auditRowGen = fc.record({
  actionType: fc.constantFrom(
    'server.create',
    'server.delete',
    'role.update',
    'player.role.assign',
  ),
  targetType: fc.option(fc.constantFrom('server', 'role', 'player'), { nil: null }),
  targetId: fc.option(
    fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !s.includes('\x00')),
    { nil: null },
  ),
  context: safeContextGen,
});

type RawRow = {
  id: string;
  hash_version: number;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  context_text: string;
  created_at_utc: string;
  actor_kind: string;
  actor_player_id: string | null;
  actor_token_id: string | null;
  actor_system_label: string | null;
  actor_ip: string | null;
  before_snapshot_text: string | null;
  after_snapshot_text: string | null;
  status_code_text: string | null;
  duration_ms_text: string | null;
  prev_hash_hex: string | null;
  row_hash_hex: string;
};

describe('audit chain integrity', () => {
  let schemaInfo: { schema: string; url: string; drop: () => Promise<void> };
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    sql = postgres(schemaInfo.url, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await schemaInfo.drop();
  });

  test.prop([fc.array(auditRowGen, { minLength: 5, maxLength: 20 })], { numRuns: 10 })(
    'sequential inserts produce verifiable hash chain',
    async (rows) => {
      const [{ n }] = await sql<[{ n: string }]>`SELECT count(*) AS n FROM audit_log`;
      const offsetBefore = Number(n);

      for (const r of rows) {
        await sql`
          INSERT INTO audit_log
            (actor_kind, actor_system_label, actor_player_id, action_type,
             target_type, target_id, context, row_hash)
          VALUES (
            'system',
            'test-property-fuzz',
            NULL,
            ${String(r.actionType)},
            ${r.targetType},
            ${r.targetId != null ? String(r.targetId) : null},
            ${JSON.stringify(r.context)}::jsonb,
            ''::bytea
          )
        `;
      }

      const raw = await sql<RawRow[]>`
        SELECT
          id::text,
          hash_version::int AS hash_version,
          action_type,
          target_type,
          target_id,
          context::text AS context_text,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_utc,
          actor_kind,
          actor_player_id::text AS actor_player_id,
          actor_token_id::text AS actor_token_id,
          actor_system_label,
          actor_ip::text AS actor_ip,
          before_snapshot::text AS before_snapshot_text,
          after_snapshot::text AS after_snapshot_text,
          status_code::text AS status_code_text,
          duration_ms::text AS duration_ms_text,
          encode(prev_hash, 'hex') AS prev_hash_hex,
          encode(row_hash, 'hex') AS row_hash_hex
        FROM audit_log
        ORDER BY audit_log.id ASC
        OFFSET ${offsetBefore}
      `;

      expect(raw).toHaveLength(rows.length);

      for (let idx = 0; idx < raw.length; idx++) {
        // idx < raw.length by the loop condition, so this index is always in bounds.
        const row = raw[idx] as RawRow;

        const prevRow =
          idx === 0
            ? offsetBefore === 0
              ? null
              : ((
                  await sql<[{ row_hash_hex: string }]>`
                    SELECT encode(row_hash, 'hex') AS row_hash_hex
                    FROM audit_log
                    ORDER BY audit_log.id ASC
                    LIMIT 1 OFFSET ${offsetBefore - 1}
                  `
                )[0] ?? null)
            : // idx !== 0 in this branch, and idx < raw.length by the loop condition,
              // so idx - 1 is always in bounds.
              { row_hash_hex: (raw[idx - 1] as RawRow).row_hash_hex };

        const expectedPrevHash = prevRow?.row_hash_hex ?? null;

        expect(row.prev_hash_hex).toBe(expectedPrevHash);

        expect(row.hash_version).toBe(2);
        const computedHash = computeRowHash(expectedPrevHash, row);

        expect(row.row_hash_hex).toBe(computedHash);
      }
    },
    60_000,
  );
});
