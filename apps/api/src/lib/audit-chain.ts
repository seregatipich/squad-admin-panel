import { createHash } from 'node:crypto';

/**
 * A single `audit_log` row as text, exactly as the append trigger sees it.
 *
 * `context_text` and `created_at` MUST be the Postgres `::text` renderings of
 * the respective columns — the `audit_log_append()` trigger hashes
 * `NEW.context::text` and `NEW.created_at::text`, so any client-side
 * reconstruction of those values would diverge from the stored `row_hash`.
 * `created_at::text` must be rendered with `TimeZone = 'UTC'`, the zone the
 * trigger pins for itself (migration 0122).
 * `prev_hash_hex`/`row_hash_hex` are the lowercase `encode(..,'hex')` of the
 * `bytea` hash columns; `prev_hash_hex` is `null` for the genesis row.
 */
export interface AuditChainRow extends Record<string, unknown> {
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
 * Incremental form of {@link verifyAuditChain}: feed rows in primary-key order
 * in any number of batches and read the verdict at the end, so a caller can
 * page through `audit_log` instead of loading the whole append-only table
 * into memory (#36). Stops accepting rows after the first break.
 */
export class AuditChainVerifier {
  private prevHashHex: string | null = null;
  private checked = 0;
  private broken: { id: string; reason: AuditChainBreakReason } | null = null;

  /** Whether a break was found; further rows are ignored once it is. */
  get isBroken(): boolean {
    return this.broken !== null;
  }

  /**
   * Verifies the next rows of the chain.
   *
   * @param rows - The rows following every row fed so far, in `id` order.
   * @returns `false` once the chain is broken, so the caller can stop reading.
   */
  feed(rows: readonly AuditChainRow[]): boolean {
    for (const row of rows) {
      if (this.broken) return false;
      // Genesis rows store NULL prev_hash; treat NULL and '' as the same empty link.
      if ((this.prevHashHex ?? '') !== (row.prev_hash_hex ?? '')) {
        this.broken = { id: row.id, reason: 'prev_hash' };
        return false;
      }
      if (expectedRowHashHex(this.prevHashHex, row) !== row.row_hash_hex) {
        this.broken = { id: row.id, reason: 'row_hash' };
        return false;
      }
      this.prevHashHex = row.row_hash_hex;
      this.checked++;
    }
    return !this.broken;
  }

  /** The verdict over every row fed so far. */
  result(): AuditChainResult {
    if (this.broken) {
      return {
        ok: false,
        checked: this.checked,
        brokenAt: this.broken.id,
        reason: this.broken.reason,
      };
    }
    return { ok: true, checked: this.checked, brokenAt: null, reason: null };
  }
}

/**
 * Walks rows in primary-key order and verifies the hash chain: each row's
 * `prev_hash` must equal the previous row's `row_hash`, and its `row_hash` must
 * equal the recomputed digest. Returns the first break (fail-fast). An empty
 * input is a valid, intact chain.
 *
 * Primary-key order is the chain order because the append trigger draws `id`
 * only after taking the chain lock (migration 0122). Read `created_at::text`
 * with the session TimeZone set to UTC, the zone the trigger hashes it in.
 */
export function verifyAuditChain(rows: readonly AuditChainRow[]): AuditChainResult {
  const verifier = new AuditChainVerifier();
  verifier.feed(rows);
  return verifier.result();
}
