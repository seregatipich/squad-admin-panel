import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { matches } from './matches.js';
import { players } from './players.js';

export const matchPlayers = pgTable(
  'match_players',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    team: smallint('team'),
    squadName: text('squad_name'),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull(),
    leftAt: timestamp('left_at', { withTimezone: true, mode: 'date' }),
    playSeconds: integer('play_seconds').notNull(),
    kills: integer('kills'),
    deaths: integer('deaths'),
    teamkills: integer('teamkills'),
    wounds: integer('wounds'),
    revives: integer('revives'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.matchId, table.playerId] }),
    playerMatchIdx: index('match_players_player_match_idx').on(table.playerId, table.matchId),
    teamChk: check('match_players_team_chk', sql`team IS NULL OR team IN (1, 2)`),
    playSecondsChk: check('match_players_play_seconds_chk', sql`play_seconds >= 0`),
    combatChk: check(
      'match_players_combat_chk',
      sql`(kills IS NULL OR kills >= 0) AND (deaths IS NULL OR deaths >= 0) AND (teamkills IS NULL OR teamkills >= 0) AND (wounds IS NULL OR wounds >= 0) AND (revives IS NULL OR revives >= 0)`,
    ),
  }),
);

export type MatchPlayerRow = typeof matchPlayers.$inferSelect;
export type NewMatchPlayer = typeof matchPlayers.$inferInsert;
