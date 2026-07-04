import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const issueLabels = pgTable(
  'issue_labels',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
  },
  (table) => ({
    nameKey: uniqueIndex('issue_labels_name_key').on(table.name),
  }),
);

export type IssueLabelRow = typeof issueLabels.$inferSelect;
export type NewIssueLabel = typeof issueLabels.$inferInsert;
