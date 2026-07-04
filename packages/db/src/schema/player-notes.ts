import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const playerNotes = pgTable(
  'player_notes',
  {
    id: uuid('id').primaryKey().notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    deletedBy: uuid('deleted_by').references(() => players.id, { onDelete: 'set null' }),
  },
  (table) => ({
    playerCreatedIdx: index('player_notes_player_id_created_at_idx').on(
      table.playerId,
      table.createdAt,
    ),
  }),
);

export type PlayerNoteRow = typeof playerNotes.$inferSelect;
export type NewPlayerNote = typeof playerNotes.$inferInsert;
