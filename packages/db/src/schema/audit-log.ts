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

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    actorKind: text('actor_kind').notNull(),
    actorPlayerId: uuid('actor_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    actorTokenId: uuid('actor_token_id').references(() => playerApiTokens.id, {
      onDelete: 'set null',
    }),
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
