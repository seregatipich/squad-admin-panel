#!/usr/bin/env tsx
/**
 * verify-audit-chain.ts
 *
 * Walks the audit_log table in primary-key order and verifies that each
 * row's row_hash equals sha256(prev_hash || canonicalized-row) for the row's
 * hash_version (v1 before migration 0135, v2 since). Fails
 * fast on the first mismatch. Exits 0 when the chain is intact. Reads the
 * table in keyset pages from one REPEATABLE READ snapshot, with the session
 * TimeZone pinned to UTC — the zone the append trigger hashes created_at in.
 *
 * Shares the walk/compare logic with the `/api/v1/audit/verify-chain`
 * endpoint via `apps/api/src/lib/audit-chain.ts`, so this out-of-band check
 * and the in-panel button agree by construction.
 *
 * External anchor (#1064): the chain alone cannot prove that its tail was not
 * truncated or that it was regenerated wholesale. Run once with
 * AUDIT_CHAIN_PRINT_HEAD=1 to print `head: <id>:<row_hash>`, record that line
 * outside the database (ops log, password manager note), and pass it back as
 * AUDIT_CHAIN_ANCHOR=<id>:<row_hash> on later runs: the run then also fails
 * (exit 1, `anchor mismatch`) when that row is missing or has another hash.
 *
 * Usage: DATABASE_URL=postgres://... [AUDIT_CHAIN_ANCHOR=id:hash]
 *        [AUDIT_CHAIN_PRINT_HEAD=1] pnpm verify:audit-chain
 */

import postgres from 'postgres';
import {
  AUDIT_CHAIN_COLUMNS_SQL,
  type AuditChainAnchor,
  type AuditChainRow,
  AuditChainVerifier,
} from '../apps/api/src/lib/audit-chain.js';

// audit_log is append-only and grows without bound (only the archiver ever
// removes rows, and only long after they're written) — loading it in one
// SELECT materializes the whole table, context::text included, in this
// process's memory at once. Walk it in fixed-size pages by id instead.
// Overridable so the multi-batch path (crossing the page boundary, and a
// chain break in a batch after the first) can be exercised in tests without
// inserting thousands of rows.
const BATCH_SIZE = Number(process.env.AUDIT_CHAIN_BATCH_SIZE) || 5_000;

/** Parses `AUDIT_CHAIN_ANCHOR` (`<id>:<64 hex chars>`); `undefined` when unset. */
function parseAnchor(value: string | undefined): AuditChainAnchor | undefined {
  if (!value) return undefined;
  const match = /^(\d+):([0-9a-f]{64})$/.exec(value);
  if (!match) {
    console.error('AUDIT_CHAIN_ANCHOR must be <id>:<64 hex chars>');
    process.exit(2);
  }
  return { id: match[1] as string, rowHashHex: match[2] as string };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const anchor = parseAnchor(process.env.AUDIT_CHAIN_ANCHOR);
  const sql = postgres(url, { max: 1, prepare: false, connection: { TimeZone: 'UTC' } });

  try {
    const verifier = new AuditChainVerifier({ anchor });
    await sql.begin('isolation level repeatable read read only', async (tx) => {
      // `created_at::text` follows the session TimeZone; the trigger hashes it in UTC.
      await tx`SET LOCAL "TimeZone" = 'UTC'`;
      let cursor = '0';
      for (;;) {
        const rows = await tx.unsafe<AuditChainRow[]>(
          `SELECT ${AUDIT_CHAIN_COLUMNS_SQL}
           FROM audit_log
           WHERE audit_log.id > $1::bigint
           ORDER BY audit_log.id ASC
           LIMIT $2`,
          [cursor, BATCH_SIZE],
        );
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
    if (process.env.AUDIT_CHAIN_PRINT_HEAD && verifier.head) {
      console.log(`head: ${verifier.head.id}:${verifier.head.rowHashHex}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('fatal:', (err as Error).message);
  process.exit(2);
});
