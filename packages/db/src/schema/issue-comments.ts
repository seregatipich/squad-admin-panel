import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues } from './issues.js';
import { players } from './players.js';

export const issueComments = pgTable(
  'issue_comments',
  {
    id: uuid('id').primaryKey().notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorPlayerId: uuid('author_player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    issueIdx: index('issue_comments_issue_idx').on(table.issueId, table.createdAt),
    bodyLenCheck: check('issue_comments_body_len', sql`char_length(body) <= 4000`),
  }),
);

export type IssueCommentRow = typeof issueComments.$inferSelect;
export type NewIssueComment = typeof issueComments.$inferInsert;
