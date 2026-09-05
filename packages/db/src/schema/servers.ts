import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { configVersions } from './config-versions.js';
import { players } from './players.js';

export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().notNull(),
    displayName: text('display_name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    status: text('status').notNull().default('pending'),
    /**
     * `container` — hosted by the panel (bridge-managed Docker container on
     * this host); `external` — hosted elsewhere, reached only over RCON/A2S
     * via `server_credentials.rcon_host`. External rows are excluded from
     * every container-bound path (status reconciler, log tailing, config
     * sync, install/start/stop) and stay `running` for as long as they exist.
     */
    runtime: text('runtime').notNull().default('container'),
    containerId: text('container_id'),
    tags: text('tags').array().notNull().default([]),
    timezone: text('timezone').notNull().default('UTC'),
    isCanary: boolean('is_canary').notNull().default(false),
    /**
     * Discord channel whose name `apps/workers/discord` rewrites into this
     * server's live status (DISCORD-6, #153). `null` — not configured, and the
     * status-channel tick skips the server entirely. Stored as `text` because a
     * Discord snowflake is an unsigned 64-bit id that does not fit `bigint`,
     * matching `discord_role_mappings.discord_role_id`.
     */
    statusChannelId: text('status_channel_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    deletedByPlayerId: uuid('deleted_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    deletionBackupMarkerId: uuid('deletion_backup_marker_id').references(
      (): AnyPgColumn => configVersions.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    slugActiveKey: uniqueIndex('servers_slug_active_key')
      .on(table.slug)
      .where(sql`deleted_at IS NULL`),
    statusIdx: index('servers_status_idx').on(table.status),
    deletedAtIdx: index('servers_deleted_at_idx').on(table.deletedAt),
    statusCheck: check(
      'servers_status_enum',
      sql`status IN ('pending','installing','ready','starting','running','stopping','stopped','failed')`,
    ),
    runtimeCheck: check('servers_runtime_enum', sql`runtime IN ('container','external')`),
  }),
);

export type ServerRow = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
