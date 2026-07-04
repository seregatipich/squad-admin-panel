import { type SQL, sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().notNull(),
    number: bigserial('number', { mode: 'number' }).notNull(),
    authorPlayerId: uuid('author_player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    assigneePlayerId: uuid('assignee_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    state: text('state').notNull().default('open'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('simple', coalesce(${issues.title}, '') || ' ' || coalesce(${issues.body}, ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    numberKey: uniqueIndex('issues_number_key').on(table.number),
    stateIdx: index('issues_state_idx').on(table.state),
    authorIdx: index('issues_author_idx').on(table.authorPlayerId),
    assigneeIdx: index('issues_assignee_idx')
      .on(table.assigneePlayerId)
      .where(sql`assignee_player_id IS NOT NULL`),
    searchIdx: index('issues_search_idx').using('gin', table.searchVector),
    titleLenCheck: check('issues_title_len', sql`char_length(title) <= 200`),
    bodyLenCheck: check('issues_body_len', sql`char_length(body) <= 4000`),
    stateCheck: check('issues_state_check', sql`state IN ('open', 'in_progress', 'closed')`),
  }),
);

export type IssueRow = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
