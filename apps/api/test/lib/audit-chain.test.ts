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

/** Builds a well-formed chain of `n` rows with sequential ids. */
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
    rows.push({ id: String(i + 1), prev_hash_hex: prev, row_hash_hex: rowHash, ...fields });
    prev = rowHash;
  }
  return rows;
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
