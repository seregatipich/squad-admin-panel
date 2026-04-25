import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const configVersions = pgTable(
  'config_versions',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    content: text('content').notNull(),
    sha256: bytea('sha256').notNull(),
    parentVersionId: uuid('parent_version_id'),
    authorSteamId64: bigint('author_steam_id64', { mode: 'bigint' }).references(
      () => players.steamId64,
      { onDelete: 'set null' },
    ),
    authorLabel: text('author_label'),
    authorIp: inet('author_ip'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverFileTimeIdx: index('config_versions_server_file_time_idx').on(
      table.serverId,
      table.filename,
      table.createdAt,
    ),
    sha256Idx: index('config_versions_sha256_idx').on(table.sha256),
    authorPresence: check(
      'config_versions_author_presence',
      sql`author_steam_id64 IS NOT NULL OR author_label IS NOT NULL`,
    ),
  }),
);

export type ConfigVersionRow = typeof configVersions.$inferSelect;
export type NewConfigVersion = typeof configVersions.$inferInsert;
