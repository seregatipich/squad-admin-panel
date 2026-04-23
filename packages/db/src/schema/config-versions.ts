import { sql } from 'drizzle-orm';
import { customType, index, inet, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';
import { users } from './users.js';

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
    authorUserId: uuid('author_user_id').references(() => users.id),
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
  }),
);

export type ConfigVersionRow = typeof configVersions.$inferSelect;
export type NewConfigVersion = typeof configVersions.$inferInsert;
