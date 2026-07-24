import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

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
 * {@link relayedAt}. The worker's idempotent hash-compare dedups any
 * at-least-once redelivery, so a re-run never duplicates effects. The API
 * enqueue path also attempts an immediate best-effort publish and stamps
 * {@link relayedAt} in-transaction on success, so healthy syncs stay
 * low-latency and the relay only has to cover rows the immediate publish
 * missed (e.g. Redis was unavailable at enqueue time).
 */
export const adminsCfgSyncOutbox = pgTable(
  'admins_cfg_sync_outbox',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** `null` while pending; set to the publish time once relayed to the stream. */
    relayedAt: timestamp('relayed_at', { withTimezone: true, mode: 'date' }),
    /** The Redis stream entry id assigned when the row was relayed (audit/debug). */
    streamId: text('stream_id'),
  },
  (table) => ({
    // Partial index the relay scans: pending rows only, oldest first (FIFO).
    pendingIdx: index('admins_cfg_sync_outbox_pending_idx')
      .on(table.createdAt)
      .where(sql`relayed_at IS NULL`),
  }),
);

export type AdminsCfgSyncOutboxRow = typeof adminsCfgSyncOutbox.$inferSelect;
export type NewAdminsCfgSyncOutbox = typeof adminsCfgSyncOutbox.$inferInsert;
