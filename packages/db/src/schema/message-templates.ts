import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    category: text('category').notNull(),
    locale: text('locale').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    sortOrderIdx: index('message_templates_sort_order_idx').on(table.sortOrder),
    createdByIdx: index('message_templates_created_by_idx').on(table.createdBy),
  }),
);

export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type NewMessageTemplate = typeof messageTemplates.$inferInsert;
