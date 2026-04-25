import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().notNull(),
    displayName: text('display_name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    status: text('status').notNull().default('pending'),
    runtime: text('runtime').notNull().default('container'),
    containerId: text('container_id'),
    tags: text('tags').array().notNull().default([]),
    timezone: text('timezone').notNull().default('UTC'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    slugKey: uniqueIndex('servers_slug_key').on(table.slug),
    statusIdx: index('servers_status_idx').on(table.status),
    statusCheck: check(
      'servers_status_enum',
      sql`status IN ('pending','installing','ready','starting','running','stopping','stopped','failed')`,
    ),
    runtimeCheck: check('servers_runtime_enum', sql`runtime IN ('container')`),
  }),
);

export type ServerRow = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
