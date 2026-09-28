#!/usr/bin/env tsx
/**
 * verify-audit-chain.ts
 *
 * Walks the audit_log table in primary-key order and verifies that each
 * row's row_hash equals sha256(prev_hash || canonicalized-row). Fails
 * fast on the first mismatch. Exits 0 when the chain is intact.
 *
 * Shares the walk/compare logic with the `/api/v1/audit/verify-chain`
 * endpoint via `apps/api/src/lib/audit-chain.ts`, so this out-of-band check
 * and the in-panel button agree by construction.
 *
 * Usage: DATABASE_URL=postgres://... pnpm verify:audit-chain
 */

import postgres from 'postgres';
import { type AuditChainRow, verifyAuditChain } from '../apps/api/src/lib/audit-chain.js';

// audit_log is append-only and grows without bound (only the archiver ever
// removes rows, and only long after they're written) — loading it in one
// SELECT materializes the whole table, context::text included, in this
// process's memory at once. Walk it in fixed-size pages by id instead.
// Overridable so the multi-batch path (crossing the page boundary, and a
// chain break in a batch after the first) can be exercised in tests without
// inserting thousands of rows.
const BATCH_SIZE = Number(process.env.AUDIT_CHAIN_BATCH_SIZE) || 5_000;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, prepare: false });

  try {
    let prevHashHex: string | null = null;
    let checked = 0;
    let lastId = '0';

    for (;;) {
      const rows = await sql<AuditChainRow[]>`
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
        WHERE id > ${lastId}
        ORDER BY audit_log.id ASC
        LIMIT ${BATCH_SIZE}
      `;
      if (rows.length === 0) break;

      const result = verifyAuditChain(rows, prevHashHex);
      checked += result.checked;
      if (!result.ok) {
        console.error(`Chain break at id=${result.brokenAt}: ${result.reason} mismatch`);
        console.error(`  verified ${checked} row(s) before the break`);
        process.exit(1);
      }
      prevHashHex = result.lastHashHex;
      lastId = rows[rows.length - 1].id;
      if (rows.length < BATCH_SIZE) break;
    }

    console.log(`ok: audit chain intact (${checked} rows)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('fatal:', (err as Error).message);
  process.exit(2);
});
