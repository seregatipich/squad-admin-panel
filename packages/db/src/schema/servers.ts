import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    status: text('status').notNull().default('pending'),
    runtime: text('runtime').notNull().default('container'),
    containerId: text('container_id'),
    tags: text('tags').array().notNull().default([]),
    timezone: text('timezone').notNull().default('UTC'),
    isCanary: boolean('is_canary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    orgSlugKey: uniqueIndex('servers_org_slug_key').on(table.orgId, table.slug),
    orgStatusIdx: index('servers_org_status_idx').on(table.orgId, table.status),
    statusCheck: check(
      'servers_status_enum',
      sql`status IN ('pending','installing','ready','starting','running','stopping','stopped','failed')`,
    ),
    runtimeCheck: check('servers_runtime_enum', sql`runtime IN ('container')`),
  }),
);

export type ServerRow = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
