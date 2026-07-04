import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { issueLabels } from './issue-labels.js';
import { issues } from './issues.js';

export const issueLabelLinks = pgTable(
  'issue_label_links',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => issueLabels.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.labelId] }),
    labelIdx: index('issue_label_links_label_idx').on(table.labelId),
  }),
);

export type IssueLabelLinkRow = typeof issueLabelLinks.$inferSelect;
export type NewIssueLabelLink = typeof issueLabelLinks.$inferInsert;
