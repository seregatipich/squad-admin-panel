import type { DatabaseClient } from '@squad/db';
import { externalBans } from '@squad/db/schema';
import { and, inArray, isNull, sql } from 'drizzle-orm';
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

/**
 * Serializes a JSON value with object keys sorted at every depth, so two
 * values that differ only in key order compare equal. Needed because `raw`
 * is read back from a jsonb column, and Postgres does not keep the key order
 * it was written with (it sorts by key length, then bytes).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fieldsDiffer(existing: ExistingBanRow, incoming: ParsedBan): boolean {
  if ((existing.nickname ?? null) !== (incoming.nickname ?? null)) return true;
  if ((existing.reason ?? null) !== (incoming.reason ?? null)) return true;
  if ((existing.adminName ?? null) !== (incoming.adminName ?? null)) return true;
  const existingExpiry = existing.expiresAt ? existing.expiresAt.getTime() : null;
  const incomingExpiry = incoming.expiresAt ? incoming.expiresAt.getTime() : null;
  if (existingExpiry !== incomingExpiry) return true;
  // `applyMergePlan` stores a missing raw as `{}`, so compare it that way too.
  if (canonicalJson(existing.raw ?? {}) !== canonicalJson(incoming.raw ?? {})) return true;
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

/**
 * Rows per INSERT / ids per revoke UPDATE / rows per batched update. Each
 * inserted row binds 10 parameters and postgres.js rejects a statement with
 * more than 65534, so a single-statement import of a large public Bans.cfg
 * (~6.5k+ new rows) would fail every sync. 1000 keeps every statement far
 * below that cap.
 */
export const MERGE_BATCH_SIZE = 1000;

/** Rows per batched `UPDATE ... FROM (VALUES ...)` (6 bind parameters each). */
const UPDATE_BATCH_ROWS = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * Applies a `MergePlan` to `external_bans` — batched inserts, batched updates
 * and batched revokes, never a DELETE — in one transaction (#854), so a
 * failure or a shutdown mid-apply leaves the previous state intact instead of
 * new bans without the revocations that belong with them. Statements are split
 * into batches so a plan of any size stays under the driver's bound-parameter
 * cap.
 *
 * Inserts skip rows that already exist (`ON CONFLICT DO NOTHING` on the
 * `external_bans_dedup_key` index): a manual sync overlapping a scheduled one
 * must not fail on a ban the other just inserted (#853). `added` counts the
 * rows actually inserted.
 */
export async function applyMergePlan(
  db: DatabaseClient,
  sourceId: string,
  plan: MergePlan,
): Promise<ApplyMergeResult> {
  return db.transaction(async (tx) => {
    let added = 0;
    for (const batch of chunk(plan.toInsert, MERGE_BATCH_SIZE)) {
      const inserted = await tx
        .insert(externalBans)
        .values(
          batch.map((record) => ({
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
        )
        .onConflictDoNothing()
        .returning({ id: externalBans.id });
      added += inserted.length;
    }

    for (const batch of chunk(plan.toUpdate, UPDATE_BATCH_ROWS)) {
      const rows = batch.map(
        (update) =>
          sql`(${update.id}::uuid, ${update.nickname}::text, ${update.reason}::text, ${update.adminName}::text, ${update.expiresAt}::timestamptz, ${JSON.stringify(update.raw ?? {})}::jsonb)`,
      );
      await tx.execute(sql`
        UPDATE external_bans AS target
        SET nickname = source.nickname,
            reason = source.reason,
            admin_name = source.admin_name,
            expires_at = source.expires_at,
            raw = source.raw,
            revoked_at = NULL
        FROM (VALUES ${sql.join(rows, sql`, `)})
          AS source (id, nickname, reason, admin_name, expires_at, raw)
        WHERE target.id = source.id`);
    }

    const revokedAt = new Date();
    for (const ids of chunk(plan.toRevokeIds, MERGE_BATCH_SIZE)) {
      await tx
        .update(externalBans)
        .set({ revokedAt })
        .where(and(inArray(externalBans.id, ids), isNull(externalBans.revokedAt)));
    }

    return {
      added,
      updated: plan.toUpdate.length,
      revoked: plan.toRevokeIds.length,
    };
  });
}
