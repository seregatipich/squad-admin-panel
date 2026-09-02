import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const ADMINS_CFG_RELOAD_OUTCOMES = [
  'confirmed',
  'file_ready_for_restart',
  'server_removed',
  'unavailable',
  'rejected',
  'timeout',
  'invalid_result',
] as const;
export type AdminsCfgReloadOutcome = (typeof ADMINS_CFG_RELOAD_OUTCOMES)[number];

/**
 * Durable transactional outbox for Admins.cfg sync tasks (SYNC-1, #34).
 *
 * A row is inserted in the SAME transaction as the domain mutation that
 * triggers a sync (role change, player role change, whitelist/VIP/clan
 * change, …). Because the insert commits or rolls back atomically with the
 * mutation, a committed mutation can never exist without a corresponding
 * pending sync task — closing the "mutation lands but the Redis publish is
 * lost" durability gap that a Redis-only queue leaves open.
 *
 * A relay ({@link relayAdminsCfgSyncOutbox}) moves pending rows onto the
 * `events:admins-cfg-sync:<server_id>` stream at-least-once and stamps
 * {@link relayedAt}. The relay starts only after the mutation commits. Its
 * stable outbox id lets the worker recognize an at-least-once redelivery.
 */
export const adminsCfgSyncOutbox = pgTable(
  'admins_cfg_sync_outbox',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    /** Lifecycle event id shared by every row in that event's server snapshot. */
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** `null` while pending; set to the publish time once relayed to the stream. */
    relayedAt: timestamp('relayed_at', { withTimezone: true, mode: 'date' }),
    /** The Redis stream entry id assigned when the row was relayed (audit/debug). */
    streamId: text('stream_id'),
    /** Set by config-sync apply, or by soft-delete/relay for `server_removed`. */
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
    /** Normalized allowlisted worker error code; never raw command output. */
    lastError: text('last_error'),
    /** Normalized reload result populated by the worker. */
    reloadOutcome: text('reload_outcome'),
  },
  (table) => ({
    // Partial index the relay scans: pending rows only, oldest first (FIFO).
    pendingIdx: index('admins_cfg_sync_outbox_pending_idx')
      .on(table.createdAt)
      .where(sql`relayed_at IS NULL`),
    correlationIdx: index('admins_cfg_sync_outbox_correlation_idx')
      .on(table.correlationId)
      .where(sql`correlation_id IS NOT NULL`),
  }),
);

export type AdminsCfgSyncOutboxRow = typeof adminsCfgSyncOutbox.$inferSelect;
export type NewAdminsCfgSyncOutbox = typeof adminsCfgSyncOutbox.$inferInsert;
