import { createHash } from 'node:crypto';

/**
 * A single `audit_log` row as text, exactly as the append trigger sees it.
 *
 * `context_text` and `created_at` MUST be the Postgres `::text` renderings of
 * the respective columns — the `audit_log_append()` trigger hashes
 * `NEW.context::text` and `NEW.created_at::text`, so any client-side
 * reconstruction of those values would diverge from the stored `row_hash`.
 * `prev_hash_hex`/`row_hash_hex` are the lowercase `encode(..,'hex')` of the
 * `bytea` hash columns; `prev_hash_hex` is `null` for the genesis row.
 */
export interface AuditChainRow {
  id: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  context_text: string;
  created_at: string;
  prev_hash_hex: string | null;
  row_hash_hex: string;
}

/** Why a chain verification failed at a given row. */
export type AuditChainBreakReason = 'prev_hash' | 'row_hash';

export interface AuditChainResult {
  /** True when every row's prev-link and row_hash reproduce exactly. */
  ok: boolean;
  /** Count of rows verified before the first break (all rows when `ok`). */
  checked: number;
  /** `id` of the first row that failed verification, else `null`. */
  brokenAt: string | null;
  /** Which check failed at `brokenAt`, else `null`. */
  reason: AuditChainBreakReason | null;
}

/**
 * The canonical string the DB trigger feeds to sha256 (after the prev hash):
 * `action_type|target_type|target_id|context::text|created_at::text`, with
 * NULL target fields rendered as the empty string.
 */
export function canonicalAuditString(row: AuditChainRow): string {
  return [
    row.action_type,
    row.target_type ?? '',
    row.target_id ?? '',
    row.context_text,
    row.created_at,
  ].join('|');
}

/**
 * Recomputes the expected `row_hash` (lowercase hex) for a row given the
 * hex-encoded hash of the preceding row (`null` for the genesis row), mirroring
 * `sha256(coalesce(prev,'') || convert_to(canonical, 'UTF8'))` from the trigger.
 */
export function expectedRowHashHex(prevHashHex: string | null, row: AuditChainRow): string {
  const prev = prevHashHex ? Buffer.from(prevHashHex, 'hex') : Buffer.alloc(0);
  const material = Buffer.concat([prev, Buffer.from(canonicalAuditString(row), 'utf-8')]);
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Walks rows in primary-key order and verifies the hash chain: each row's
 * `prev_hash` must equal the previous row's `row_hash`, and its `row_hash` must
 * equal the recomputed digest. Returns the first break (fail-fast). An empty
 * input is a valid, intact chain.
 */
export function verifyAuditChain(rows: readonly AuditChainRow[]): AuditChainResult {
  let prevHashHex: string | null = null;
  let checked = 0;

  for (const row of rows) {
    // Genesis rows store NULL prev_hash; treat NULL and '' as the same empty link.
    if ((prevHashHex ?? '') !== (row.prev_hash_hex ?? '')) {
      return { ok: false, checked, brokenAt: row.id, reason: 'prev_hash' };
    }
    if (expectedRowHashHex(prevHashHex, row) !== row.row_hash_hex) {
      return { ok: false, checked, brokenAt: row.id, reason: 'row_hash' };
    }
    prevHashHex = row.row_hash_hex;
    checked++;
  }

  return { ok: true, checked, brokenAt: null, reason: null };
}
