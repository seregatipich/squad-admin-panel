import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';
import { desc, sql } from 'drizzle-orm';

type AuditTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export interface AuditEntry {
  actorPlayerId: string | null;
  actionType: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: Record<string, unknown>;
}

function canonicalJsonString(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJsonString).join(',')}]`;
  const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonString(v)}`).join(',')}}`;
}

/**
 * Append an audit_log row from the worker, mirroring the chained-hash
 * pattern used by the API audit plugin. Each row's row_hash is
 * sha256(prev_hash || canonical_json(payload)) so the chain stays valid
 * regardless of who appended.
 */
async function appendWorkerAuditRow(tx: AuditTransaction, entry: AuditEntry): Promise<void> {
  const last = await tx
    .select({ rowHash: auditLog.rowHash })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);
  const prevHash = last[0]?.rowHash ?? null;

  const payload = {
    actor_kind: entry.actorPlayerId ? 'steam' : 'system',
    actor_player_id: entry.actorPlayerId,
    actor_system_label: entry.actorPlayerId ? null : 'worker-config-sync',
    action_type: entry.actionType,
    target_type: entry.targetType,
    target_id: entry.targetId,
    before_snapshot: entry.before,
    after_snapshot: entry.after,
    context: entry.context,
  };
  const canonical = canonicalJsonString(payload);
  const hasher = createHash('sha256');
  if (prevHash) hasher.update(prevHash);
  hasher.update(canonical, 'utf8');
  const rowHash = hasher.digest();

  await tx.execute(sql`
    INSERT INTO audit_log (
      actor_kind, actor_player_id, actor_token_id, actor_system_label, actor_ip,
      action_type, target_type, target_id,
      before_snapshot, after_snapshot, context,
      status_code, duration_ms, prev_hash, row_hash
    ) VALUES (
      ${payload.actor_kind},
      ${payload.actor_player_id},
      NULL,
      ${payload.actor_system_label},
      NULL,
      ${payload.action_type},
      ${payload.target_type},
      ${payload.target_id},
      ${payload.before_snapshot ? sql`${JSON.stringify(payload.before_snapshot)}::jsonb` : sql`NULL`},
      ${payload.after_snapshot ? sql`${JSON.stringify(payload.after_snapshot)}::jsonb` : sql`NULL`},
      ${sql`${JSON.stringify(payload.context)}::jsonb`},
      NULL,
      NULL,
      ${prevHash},
      ${rowHash}
    )
  `);
}

export async function appendWorkerAuditInTransaction(
  tx: AuditTransaction,
  entry: AuditEntry,
): Promise<void> {
  await appendWorkerAuditRow(tx, entry);
}

export async function appendWorkerAudit(db: DatabaseClient, entry: AuditEntry): Promise<void> {
  await db.transaction((tx) => appendWorkerAuditRow(tx, entry));
}
