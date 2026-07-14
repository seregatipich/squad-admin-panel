import { describe, expect, it } from 'vitest';
import type { ParsedBan } from '../src/adapters/index.js';
import type { ExistingBanRow } from '../src/merge.js';
import { planMerge } from '../src/merge.js';

function ban(overrides: Partial<ParsedBan> = {}): ParsedBan {
  return {
    steamId64: '76561198000000001',
    eosId: null,
    nickname: 'Cheater',
    reason: 'aimbot',
    adminName: 'AdminX',
    issuedAt: null,
    expiresAt: null,
    raw: {},
    ...overrides,
  };
}

function existingRow(overrides: Partial<ExistingBanRow> = {}): ExistingBanRow {
  return {
    id: 'row-1',
    steamId64: '76561198000000001',
    eosId: null,
    nickname: 'Cheater',
    reason: 'aimbot',
    adminName: 'AdminX',
    issuedAt: null,
    expiresAt: null,
    raw: {},
    revokedAt: null,
    ...overrides,
  };
}

describe('planMerge', () => {
  it('queues a brand-new record for insert', () => {
    const plan = planMerge([], [ban()]);
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.toUpdate).toHaveLength(0);
    expect(plan.toRevokeIds).toHaveLength(0);
  });

  it('does not update an identical record on a repeat sync (0 added / 0 updated)', () => {
    const plan = planMerge([existingRow()], [ban()]);
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
    expect(plan.toRevokeIds).toHaveLength(0);
  });

  it('queues an update when reason/expiresAt changed', () => {
    const plan = planMerge(
      [existingRow()],
      [ban({ reason: 'teamkilling', expiresAt: new Date('2026-06-01T00:00:00.000Z') })],
    );
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]).toMatchObject({
      id: 'row-1',
      reason: 'teamkilling',
      revokedAt: null,
    });
  });

  it('revokes (never deletes) a record missing from the source', () => {
    const plan = planMerge([existingRow()], []);
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
    expect(plan.toRevokeIds).toEqual(['row-1']);
  });

  it('does not re-revoke an already-revoked row', () => {
    const plan = planMerge([existingRow({ revokedAt: new Date('2026-01-01T00:00:00.000Z') })], []);
    expect(plan.toRevokeIds).toHaveLength(0);
  });

  it('clears revokedAt (via toUpdate) when a previously-revoked record reappears', () => {
    const plan = planMerge(
      [existingRow({ revokedAt: new Date('2026-01-01T00:00:00.000Z') })],
      [ban()],
    );
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]).toMatchObject({ id: 'row-1', revokedAt: null });
    expect(plan.toRevokeIds).toHaveLength(0);
  });

  it('matches keys using the epoch coalesce for a null issuedAt, exactly like the DB dedup index', () => {
    const plan = planMerge([existingRow({ issuedAt: null })], [ban({ issuedAt: null })]);
    // Same steamId64 + null issuedAt on both sides must match the same key
    // (not create a duplicate insert).
    expect(plan.toInsert).toHaveLength(0);
  });

  it('counts duplicate incoming keys (two source rows resolving to the same dedup key) without inserting twice', () => {
    const plan = planMerge([], [ban(), ban()]);
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.skippedDuplicateKeys).toBe(1);
  });
});
