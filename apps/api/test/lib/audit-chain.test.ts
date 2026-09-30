import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AuditChainRow,
  AuditChainVerifier,
  verifyAuditChain,
} from '../../src/lib/audit-chain.js';

// Independent reference implementation of the DB trigger's hash, used only to
// build fixtures here so verifyAuditChain is exercised against hashes it did
// not itself produce.
function refRowHashHex(
  prevHashHex: string | null,
  fields: Pick<
    AuditChainRow,
    'action_type' | 'target_type' | 'target_id' | 'context_text' | 'created_at'
  >,
): string {
  const prev = prevHashHex ? Buffer.from(prevHashHex, 'hex') : Buffer.alloc(0);
  const canonical = [
    fields.action_type,
    fields.target_type ?? '',
    fields.target_id ?? '',
    fields.context_text,
    fields.created_at,
  ].join('|');
  return createHash('sha256')
    .update(Buffer.concat([prev, Buffer.from(canonical, 'utf-8')]))
    .digest('hex');
}

/** Columns the v1 form ignores; v2 rows hash them too. */
const EXTRA_COLUMNS = {
  created_at_utc: '',
  actor_kind: 'system',
  actor_player_id: null,
  actor_token_id: null,
  actor_system_label: 'unit-test',
  actor_ip: null,
  before_snapshot_text: null,
  after_snapshot_text: null,
  status_code_text: null,
  duration_ms_text: null,
} as const;

/** Builds a well-formed v1 chain (rows written before migration 0135) of `n` rows. */
function buildChain(n: number): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const fields = {
      action_type: `action.${i}`,
      target_type: i % 2 === 0 ? 'server' : null,
      target_id: i % 2 === 0 ? `srv-${i}` : null,
      context_text: `{"seq": ${i}}`,
      created_at: `2026-07-23 10:00:0${i}+00`,
    };
    const rowHash = refRowHashHex(prev, fields);
    rows.push({
      id: String(i + 1),
      hash_version: 1,
      ...EXTRA_COLUMNS,
      prev_hash_hex: prev,
      row_hash_hex: rowHash,
      ...fields,
    });
    prev = rowHash;
  }
  return rows;
}

// Independent reference of the v2 trigger form (migration 0135).
function refV2HashHex(prevHashHex: string | null, row: AuditChainRow): string {
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
  const prev = prevHashHex ? Buffer.from(prevHashHex, 'hex') : Buffer.alloc(0);
  return createHash('sha256')
    .update(Buffer.concat([prev, Buffer.from(canonical, 'utf-8')]))
    .digest('hex');
}

/** Appends `n` v2 rows (ids continuing from `rows`) to a chain. */
function appendV2Rows(rows: AuditChainRow[], n: number): AuditChainRow[] {
  const out = [...rows];
  let prev = out.at(-1)?.row_hash_hex ?? null;
  for (let i = 0; i < n; i++) {
    const draft: AuditChainRow = {
      id: String(out.length + 1),
      hash_version: 2,
      ...EXTRA_COLUMNS,
      created_at: 'ignored-by-v2',
      created_at_utc: `2026-09-28T10:00:0${i}.000000Z`,
      actor_ip: '10.0.0.1/32',
      after_snapshot_text: `{"v": ${i}}`,
      status_code_text: '200',
      action_type: `v2.action.${i}`,
      target_type: 'server',
      target_id: `a|b-${i}`,
      context_text: '{}',
      prev_hash_hex: prev,
      row_hash_hex: '',
    };
    draft.row_hash_hex = refV2HashHex(prev, draft);
    out.push(draft);
    prev = draft.row_hash_hex;
  }
  return out;
}

describe('verifyAuditChain', () => {
  it('reports an empty chain as intact', () => {
    expect(verifyAuditChain([])).toEqual({ ok: true, checked: 0, brokenAt: null, reason: null });
  });

  it('accepts a well-formed chain and counts every row', () => {
    const result = verifyAuditChain(buildChain(6));
    expect(result).toEqual({ ok: true, checked: 6, brokenAt: null, reason: null });
  });

  it('detects a tampered row payload as a row_hash break at that row', () => {
    const rows = buildChain(5);
    // Simulate a superuser editing the stored context without recomputing the hash.
    // rows[2] is defined because buildChain(5) produced 5 elements.
    rows[2] = { ...(rows[2] as AuditChainRow), context_text: '{"seq": 2, "tampered": true}' };

    const result = verifyAuditChain(rows);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('row_hash');
    expect(result.brokenAt).toBe('3');
    expect(result.checked).toBe(2);
  });

  it('detects a broken prev-link as a prev_hash break', () => {
    const rows = buildChain(4);
    // Replace a row's prev_hash so it no longer matches the preceding row_hash.
    // rows[2] is defined because buildChain(4) produced 4 elements.
    rows[2] = { ...(rows[2] as AuditChainRow), prev_hash_hex: 'deadbeef'.repeat(8) };

    const result = verifyAuditChain(rows);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('prev_hash');
    expect(result.brokenAt).toBe('3');
    expect(result.checked).toBe(2);
  });

  it('detects a tampered genesis row', () => {
    const rows = buildChain(3);
    // rows[0] is defined because buildChain(3) produced 3 elements.
    rows[0] = { ...(rows[0] as AuditChainRow), action_type: 'action.forged' };

    const result = verifyAuditChain(rows);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('row_hash');
    expect(result.brokenAt).toBe('1');
    expect(result.checked).toBe(0);
  });

  it('accepts a chain that moves from v1 to v2 rows', () => {
    const rows = appendV2Rows(buildChain(3), 3);
    expect(verifyAuditChain(rows)).toEqual({ ok: true, checked: 6, brokenAt: null, reason: null });
  });

  it('detects a rewritten actor on a v2 row (issue #50)', () => {
    const rows = appendV2Rows(buildChain(2), 2);
    rows[3] = { ...(rows[3] as AuditChainRow), actor_system_label: 'someone-else' };
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, brokenAt: '4', reason: 'row_hash' });
  });

  it('detects a before_snapshot, status_code or actor_ip rewrite on a v2 row', () => {
    for (const patch of [
      { before_snapshot_text: '{"forged": true}' },
      { status_code_text: '500' },
      { actor_ip: '192.0.2.1/32' },
    ]) {
      const rows = appendV2Rows([], 2);
      rows[1] = { ...(rows[1] as AuditChainRow), ...patch };
      expect(verifyAuditChain(rows)).toMatchObject({
        ok: false,
        brokenAt: '2',
        reason: 'row_hash',
      });
    }
  });

  it('rejects a v1 row after the chain moved to v2 (downgrade)', () => {
    const rows = appendV2Rows(buildChain(1), 1);
    const downgraded = buildChain(3)[2] as AuditChainRow;
    rows.push({ ...downgraded, id: '3', prev_hash_hex: (rows[1] as AuditChainRow).row_hash_hex });
    expect(verifyAuditChain(rows)).toMatchObject({
      ok: false,
      brokenAt: '3',
      reason: 'hash_version',
      checked: 2,
    });
  });

  it('rejects an unknown hash_version', () => {
    const rows = buildChain(1);
    rows[0] = { ...(rows[0] as AuditChainRow), hash_version: 3 };
    expect(verifyAuditChain(rows)).toMatchObject({
      ok: false,
      brokenAt: '1',
      reason: 'hash_version',
    });
  });
});

describe('AuditChainVerifier (#36 finding 17)', () => {
  it('verifies a chain fed in batches exactly like the whole-array form', () => {
    const rows = buildChain(9);
    const verifier = new AuditChainVerifier();
    for (let i = 0; i < rows.length; i += 4) {
      expect(verifier.feed(rows.slice(i, i + 4))).toBe(true);
    }
    expect(verifier.result()).toEqual(verifyAuditChain(rows));
    expect(verifier.result()).toEqual({ ok: true, checked: 9, brokenAt: null, reason: null });
  });

  it('carries the previous hash across a batch boundary and stops at a break', () => {
    const rows = buildChain(6);
    // rows[3] opens the second batch; its prev link must match rows[2] from the first.
    rows[3] = { ...(rows[3] as AuditChainRow), prev_hash_hex: 'deadbeef'.repeat(8) };
    const verifier = new AuditChainVerifier();
    expect(verifier.feed(rows.slice(0, 3))).toBe(true);
    expect(verifier.feed(rows.slice(3))).toBe(false);
    expect(verifier.isBroken).toBe(true);
    expect(verifier.feed(buildChain(1))).toBe(false);
    expect(verifier.result()).toEqual({
      ok: false,
      checked: 3,
      brokenAt: '4',
      reason: 'prev_hash',
    });
  });
});
