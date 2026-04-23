#!/usr/bin/env tsx
/**
 * verify-audit-chain.ts
 *
 * Walks the audit_log table in primary-key order and verifies that each
 * row's row_hash equals sha256(prev_hash || canonicalized-row). Fails
 * fast on the first mismatch. Exits 0 when the chain is intact.
 *
 * Usage: DATABASE_URL=postgres://... pnpm verify:audit-chain
 */

import { createHash } from 'node:crypto';
import postgres from 'postgres';

interface Row {
  id: string;
  created_at: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  context: Record<string, unknown>;
  prev_hash: Buffer | null;
  row_hash: Buffer;
}

function canonical(row: Row): string {
  return [
    row.action_type,
    row.target_type ?? '',
    row.target_id ?? '',
    JSON.stringify(row.context),
    row.created_at,
  ].join('|');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, prepare: false });
  let prevHash: Buffer | null = null;
  let count = 0;

  try {
    const rows = await sql<Row[]>`
      SELECT id::text, created_at::text, action_type, target_type, target_id,
             context, prev_hash, row_hash
        FROM audit_log
        ORDER BY id ASC
    `;

    for (const row of rows) {
      const expectedPrev = prevHash ?? Buffer.alloc(0);
      const actualPrev = row.prev_hash ?? Buffer.alloc(0);
      if (!expectedPrev.equals(actualPrev)) {
        console.error(`Chain break at id=${row.id}: prev_hash mismatch`);
        process.exit(1);
      }
      const material = Buffer.concat([expectedPrev, Buffer.from(canonical(row), 'utf-8')]);
      const expected = createHash('sha256').update(material).digest();
      if (!expected.equals(row.row_hash)) {
        console.error(`Chain break at id=${row.id}: row_hash mismatch`);
        console.error(`  expected=${expected.toString('hex')}`);
        console.error(`  actual  =${row.row_hash.toString('hex')}`);
        process.exit(1);
      }
      prevHash = row.row_hash;
      count++;
    }
    console.log(`ok: audit chain intact (${count} rows)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('fatal:', (err as Error).message);
  process.exit(2);
});
