import { createHash } from 'node:crypto';

/**
 * The column list every chain verifier selects (the
 * `/api/v1/audit/verify-chain` route and `scripts/verify-audit-chain.ts`), so
 * both read exactly the renderings the `audit_log_append()` trigger hashes.
 * Every value is rendered by Postgres (`::text`, `to_char(... UTC)`), never
 * reconstructed client-side. Run it with the session TimeZone pinned to UTC:
 * the v1 form hashes `created_at::text`.
 */
export const AUDIT_CHAIN_COLUMNS_SQL = `
  id::text AS id,
  hash_version::int AS hash_version,
  action_type,
  target_type,
  target_id,
  context::text AS context_text,
  created_at::text AS created_at,
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
`;

/**
 * A single `audit_log` row as text, exactly as the append trigger sees it
 * (see {@link AUDIT_CHAIN_COLUMNS_SQL}).
 *
 * `hash_version` selects the canonical form: `1` for rows written before
 * migration 0132 (`action|target|context::text|created_at::text`), `2` for
 * every row since (all columns, length-prefixed, UTC timestamp). Any
 * `created_at`/`context_text` must be the Postgres `::text` renderings the v1
 * form hashes; `created_at::text` is rendered with `TimeZone = 'UTC'`, the zone
 * the trigger pins for itself (migration 0122). `prev_hash_hex`/`row_hash_hex`
 * are the lowercase `encode(..,'hex')` of the `bytea` hash columns;
 * `prev_hash_hex` is `null` for the genesis row.
 */
export interface AuditChainRow extends Record<string, unknown> {
  id: string;
  hash_version: number;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  context_text: string;
  created_at: string;
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
}

/**
 * Why a chain verification failed at a given row. `hash_version` means an
 * unknown canonical-form version, or a v1 row after the chain already moved to
 * v2 (a downgrade to the weaker form).
 */
export type AuditChainBreakReason = 'prev_hash' | 'row_hash' | 'hash_version';

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
 * The v1 canonical string (rows written before migration 0132):
 * `action_type|target_type|target_id|context::text|<created_at>`, where
 * `<created_at>` is `audit_log_created_at_text(created_at)`, with NULL target
 * fields rendered as the empty string.
 */
export function canonicalAuditStringV1(row: AuditChainRow): string {
  return [
    row.action_type,
    row.target_type ?? '',
    row.target_id ?? '',
    row.context_text,
    row.created_at,
  ].join('|');
}

/** One v2 field: `|-` for NULL, else `|<utf-8 byte length>:<value>`. */
function v2Field(value: string | null): string {
  return value === null ? '|-' : `|${Buffer.byteLength(value, 'utf-8')}:${value}`;
}

/**
 * The v2 canonical string, mirroring `audit_log_append()` from migration 0132:
 * `'v2'` followed by every column as a length-prefixed field, so no value can be
 * rewritten (or shifted across a separator) without changing the digest.
 */
export function canonicalAuditStringV2(row: AuditChainRow): string {
  return [
    'v2',
    v2Field(row.id),
    v2Field(row.created_at_utc),
    v2Field(row.actor_kind),
    v2Field(row.actor_player_id),
    v2Field(row.actor_token_id),
    v2Field(row.actor_system_label),
    v2Field(row.actor_ip),
    v2Field(row.action_type),
    v2Field(row.target_type),
    v2Field(row.target_id),
    v2Field(row.before_snapshot_text),
    v2Field(row.after_snapshot_text),
    v2Field(row.context_text),
    v2Field(row.status_code_text),
    v2Field(row.duration_ms_text),
  ].join('');
}

/**
 * The canonical string the DB trigger fed to sha256 (after the prev hash) for
 * this row's `hash_version`.
 *
 * @throws Error when `hash_version` is not 1 or 2.
 */
export function canonicalAuditString(row: AuditChainRow): string {
  const version = Number(row.hash_version);
  if (version === 1) return canonicalAuditStringV1(row);
  if (version === 2) return canonicalAuditStringV2(row);
  throw new Error(`unknown audit hash_version ${row.hash_version}`);
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

/** {@link verifyAuditChain} plus the last verified row's hash, to resume a walk across batches. */
export interface AuditChainBatchResult extends AuditChainResult {
  /** `row_hash_hex` of the last row verified in this batch (carry into the next batch's `prevHashHex`), or the input `prevHashHex` when the batch was empty. */
  lastHashHex: string | null;
}

/**
 * Incremental form of {@link verifyAuditChain}: feed rows in primary-key order
 * in any number of batches and read the verdict at the end, so a caller can
 * page through `audit_log` instead of loading the whole append-only table
 * into memory (#36). Stops accepting rows after the first break.
 */
export class AuditChainVerifier {
  private prevHashHex: string | null = null;
  private highestVersion = 0;
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
      const version = Number(row.hash_version);
      if ((version !== 1 && version !== 2) || version < this.highestVersion) {
        this.broken = { id: row.id, reason: 'hash_version' };
        return false;
      }
      this.highestVersion = version;
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
 * Versions never go back down, and TRUNCATE of `audit_log` is refused by the
 * database since migration 0132, so an emptied table cannot pass as intact.
 */
export function verifyAuditChain(rows: readonly AuditChainRow[]): AuditChainResult {
  const verifier = new AuditChainVerifier();
  verifier.feed(rows);
  return verifier.result();
}
