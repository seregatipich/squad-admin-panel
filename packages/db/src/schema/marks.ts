import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const markTypes = pgTable(
  'mark_types',
  {
    id: smallint('id').primaryKey().notNull(),
    slug: text('slug').notNull(),
    labelEn: text('label_en').notNull(),
    labelRu: text('label_ru').notNull(),
    icon: text('icon').notNull(),
    severity: smallint('severity').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull(),
  },
  (table) => ({
    slugKey: uniqueIndex('mark_types_slug_key').on(table.slug),
  }),
);

export const playerMarks = pgTable(
  'player_marks',
  {
    id: uuid('id').primaryKey().notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    markTypeId: smallint('mark_type_id')
      .notNull()
      .references(() => markTypes.id, { onDelete: 'restrict' }),
    comment: text('comment'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => players.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    clearedBy: uuid('cleared_by').references(() => players.id, { onDelete: 'set null' }),
    clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'date' }),
    clearReason: text('clear_reason'),
  },
  (table) => ({
    activeTypeUniqueIdx: uniqueIndex('player_marks_active_type_unique_idx')
      .on(table.playerId, table.markTypeId)
      .where(sql`cleared_at IS NULL`),
    playerIdIdx: index('player_marks_player_id_idx').on(table.playerId),
    commentLenCheck: check('player_marks_comment_len', sql`char_length(comment) <= 512`),
  }),
);

export type MarkTypeRow = typeof markTypes.$inferSelect;
export type NewMarkType = typeof markTypes.$inferInsert;
export type PlayerMarkRow = typeof playerMarks.$inferSelect;
export type NewPlayerMark = typeof playerMarks.$inferInsert;
