#!/usr/bin/env tsx
/**
 * verify-audit-chain.ts
 *
 * Walks the audit_log table in primary-key order and verifies that each
 * row's row_hash equals sha256(prev_hash || canonicalized-row). Fails
 * fast on the first mismatch. Exits 0 when the chain is intact. Reads the
 * table in keyset pages from one REPEATABLE READ snapshot, with the session
 * TimeZone pinned to UTC — the zone the append trigger hashes created_at in.
 *
 * Shares the walk/compare logic with the `/api/v1/audit/verify-chain`
 * endpoint via `apps/api/src/lib/audit-chain.ts`, so this out-of-band check
 * and the in-panel button agree by construction.
 *
 * Usage: DATABASE_URL=postgres://... pnpm verify:audit-chain
 */

import postgres from 'postgres';
import { type AuditChainRow, AuditChainVerifier } from '../apps/api/src/lib/audit-chain.js';

const BATCH_SIZE = 5_000;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, prepare: false, connection: { TimeZone: 'UTC' } });

  try {
    const verifier = new AuditChainVerifier();
    await sql.begin('isolation level repeatable read read only', async (tx) => {
      let cursor = '0';
      for (;;) {
        const rows = await tx<AuditChainRow[]>`
          SELECT
            id::text AS id,
            action_type,
            target_type,
            target_id,
            context::text AS context_text,
            created_at::text AS created_at,
            encode(prev_hash, 'hex') AS prev_hash_hex,
            encode(row_hash, 'hex') AS row_hash_hex
          FROM audit_log
          WHERE audit_log.id > ${cursor}::bigint
          ORDER BY audit_log.id ASC
          LIMIT ${BATCH_SIZE}
        `;
        const last = rows.at(-1);
        if (!last || !verifier.feed(rows)) return;
        cursor = last.id;
      }
    });

    const result = verifier.result();
    if (!result.ok) {
      console.error(`Chain break at id=${result.brokenAt}: ${result.reason} mismatch`);
      console.error(`  verified ${result.checked} row(s) before the break`);
      process.exit(1);
    }
    console.log(`ok: audit chain intact (${result.checked} rows)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('fatal:', (err as Error).message);
  process.exit(2);
});
