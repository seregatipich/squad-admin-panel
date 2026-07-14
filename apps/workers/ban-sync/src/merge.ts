import type { DatabaseClient } from '@squad/db';
import { externalBans } from '@squad/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ParsedBan } from './adapters/index.js';

export interface ExistingBanRow {
  id: string;
  steamId64: string | null;
  eosId: string | null;
  nickname: string | null;
  reason: string | null;
  adminName: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  raw: unknown;
  revokedAt: Date | null;
}

export interface MergeUpdate {
  id: string;
  nickname: string | null;
  reason: string | null;
  adminName: string | null;
  expiresAt: Date | null;
  raw: unknown;
  revokedAt: null;
}

export interface MergePlan {
  toInsert: ParsedBan[];
  toUpdate: MergeUpdate[];
  toRevokeIds: string[];
  skippedDuplicateKeys: number;
}

export interface ApplyMergeResult {
  added: number;
  updated: number;
  revoked: number;
}

/**
 * Builds the dedup key exactly matching the DB's `external_bans_dedup_key`
 * unique index: `(source_id, coalesce(steam_id64,''), coalesce(eos_id,''),
 * coalesce(issued_at,'epoch'))`. `sourceId` is deliberately not part of the
 * in-memory key (the caller always scopes both sides to one source), but
 * the coalesce semantics for the other three columns must match exactly or
 * a re-sync could insert a row that collides on the real unique index.
 */
function dedupKey(row: {
  steamId64: string | null;
  eosId: string | null;
  issuedAt: Date | null;
}): string {
  const steam = row.steamId64 ?? '';
  const eos = row.eosId ?? '';
  const issued = row.issuedAt ? row.issuedAt.toISOString() : 'epoch';
  return `${steam}|${eos}|${issued}`;
}

function fieldsDiffer(existing: ExistingBanRow, incoming: ParsedBan): boolean {
  if ((existing.nickname ?? null) !== (incoming.nickname ?? null)) return true;
  if ((existing.reason ?? null) !== (incoming.reason ?? null)) return true;
  if ((existing.adminName ?? null) !== (incoming.adminName ?? null)) return true;
  const existingExpiry = existing.expiresAt ? existing.expiresAt.getTime() : null;
  const incomingExpiry = incoming.expiresAt ? incoming.expiresAt.getTime() : null;
  if (existingExpiry !== incomingExpiry) return true;
  if (JSON.stringify(existing.raw ?? null) !== JSON.stringify(incoming.raw ?? null)) return true;
  if (existing.revokedAt !== null) return true;
  return false;
}

/**
 * Pure diff between the current DB rows for a source and the freshly
 * parsed incoming records, keyed identically to the DB's unique dedup
 * index. Never deletes: records absent from the incoming set are queued
 * for `revoked_at`, and a record that reappears after being revoked gets
 * `revoked_at` cleared via `toUpdate`.
 */
export function planMerge(existing: ExistingBanRow[], incoming: ParsedBan[]): MergePlan {
  const existingByKey = new Map<string, ExistingBanRow>();
  for (const row of existing) {
    existingByKey.set(dedupKey(row), row);
  }

  const toInsert: ParsedBan[] = [];
  const toUpdate: MergeUpdate[] = [];
  const seenKeys = new Set<string>();
  let skippedDuplicateKeys = 0;

  for (const record of incoming) {
    const key = dedupKey(record);
    if (seenKeys.has(key)) {
      skippedDuplicateKeys++;
      continue;
    }
    seenKeys.add(key);

    const match = existingByKey.get(key);
    if (!match) {
      toInsert.push(record);
      continue;
    }
    if (fieldsDiffer(match, record)) {
      toUpdate.push({
        id: match.id,
        nickname: record.nickname,
        reason: record.reason,
        adminName: record.adminName,
        expiresAt: record.expiresAt,
        raw: record.raw,
        revokedAt: null,
      });
    }
  }

  const toRevokeIds = existing
    .filter((row) => row.revokedAt === null && !seenKeys.has(dedupKey(row)))
    .map((row) => row.id);

  return { toInsert, toUpdate, toRevokeIds, skippedDuplicateKeys };
}

/** Applies a `MergePlan` to `external_bans`: insert, per-row update, and a single batched revoke — never a DELETE. */
export async function applyMergePlan(
  db: DatabaseClient,
  sourceId: string,
  plan: MergePlan,
): Promise<ApplyMergeResult> {
  if (plan.toInsert.length > 0) {
    await db.insert(externalBans).values(
      plan.toInsert.map((record) => ({
        id: uuidv7(),
        sourceId,
        steamId64: record.steamId64,
        eosId: record.eosId,
        nickname: record.nickname,
        reason: record.reason,
        adminName: record.adminName,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        raw: record.raw ?? {},
      })),
    );
  }

  for (const update of plan.toUpdate) {
    await db
      .update(externalBans)
      .set({
        nickname: update.nickname,
        reason: update.reason,
        adminName: update.adminName,
        expiresAt: update.expiresAt,
        raw: update.raw ?? {},
        revokedAt: update.revokedAt,
      })
      .where(eq(externalBans.id, update.id));
  }

  if (plan.toRevokeIds.length > 0) {
    await db
      .update(externalBans)
      .set({ revokedAt: new Date() })
      .where(and(inArray(externalBans.id, plan.toRevokeIds), isNull(externalBans.revokedAt)));
  }

  return {
    added: plan.toInsert.length,
    updated: plan.toUpdate.length,
    revoked: plan.toRevokeIds.length,
  };
}
