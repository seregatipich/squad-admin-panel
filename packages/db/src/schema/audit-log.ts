import {
  bigserial,
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
import { organizations } from './organizations.js';
import { users } from './users.js';

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
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorIp: inet('actor_ip'),
    actorKind: text('actor_kind').notNull().default('user'),
    actionType: text('action_type').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    beforeSnapshot: jsonb('before_snapshot'),
    afterSnapshot: jsonb('after_snapshot'),
    context: jsonb('context').notNull().default({}),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms'),
    orgId: uuid('org_id').references(() => organizations.id),
    prevHash: bytea('prev_hash'),
    rowHash: bytea('row_hash').notNull(),
  },
  (table) => ({
    createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
    actorIdx: index('audit_log_actor_idx').on(table.actorUserId, table.createdAt),
    actionIdx: index('audit_log_action_idx').on(table.actionType, table.createdAt),
    targetIdx: index('audit_log_target_idx').on(table.targetType, table.targetId),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
