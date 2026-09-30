import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { playerApiTokens } from './player-api-tokens.js';
import { players } from './players.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Append-only, SHA-256 hash-chained audit trail.
 *
 * The `trg_audit_log_ins` trigger (`audit_log_append()`, migration 0119) takes
 * an advisory lock, assigns {@link auditLog.id} from the `audit_log_id_seq`
 * sequence — the column has no default, so ids follow the chain order — and
 * computes `prev_hash`/`row_hash` over the UTC/ISO rendering of `created_at`
 * (`audit_log_created_at_text()`). UPDATE and DELETE are rejected by triggers,
 * so the actor references are NO ACTION: a referenced player or token cannot
 * be deleted, only anonymised.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    // No column default since migration 0122: the append trigger draws the id
    // from this serial's sequence after taking the chain lock, so id order is
    // chain order. Declared bigserial so inserts may omit it.
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    actorKind: text('actor_kind').notNull(),
    actorPlayerId: uuid('actor_player_id').references(() => players.id),
    actorTokenId: uuid('actor_token_id').references(() => playerApiTokens.id),
    actorSystemLabel: text('actor_system_label'),
    actorIp: inet('actor_ip'),
    actionType: text('action_type').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    beforeSnapshot: jsonb('before_snapshot'),
    afterSnapshot: jsonb('after_snapshot'),
    context: jsonb('context').notNull().default({}),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms'),
    prevHash: bytea('prev_hash'),
    rowHash: bytea('row_hash').notNull(),
    /**
     * Canonical-form version `row_hash` was computed with: 1 before migration
     * 0132, 2 since. Always set by the `audit_log_append()` trigger.
     */
    hashVersion: smallint('hash_version').notNull().default(1),
  },
  (table) => ({
    createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
    actorPlayerIdx: index('audit_log_actor_player_idx').on(table.actorPlayerId, table.createdAt),
    actionIdx: index('audit_log_action_idx').on(table.actionType, table.createdAt),
    targetIdx: index('audit_log_target_idx').on(table.targetType, table.targetId),
    actorKindCheck: check(
      'audit_log_actor_kind',
      sql`(actor_kind = 'steam'  AND actor_player_id IS NOT NULL AND actor_system_label IS NULL)
       OR (actor_kind = 'system' AND actor_player_id IS NULL     AND actor_system_label IS NOT NULL)`,
    ),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
