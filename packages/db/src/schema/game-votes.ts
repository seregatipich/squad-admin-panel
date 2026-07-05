import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

export const gameVotes = pgTable(
  'game_votes',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    initiatorPlayerId: uuid('initiator_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    voteType: text('vote_type').notNull(),
    mapCurrent: text('map_current'),
    mapNext: text('map_next'),
    mapTarget: text('map_target'),
    votesCollected: integer('votes_collected').notNull().default(0),
    votesRequired: integer('votes_required').notNull().default(0),
    result: text('result'),
    durationSeconds: integer('duration_seconds'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    serverStartedKey: uniqueIndex('game_votes_server_started_key').on(
      table.serverId,
      table.startedAt,
    ),
    serverStartedIdx: index('game_votes_server_started_idx').on(
      table.serverId,
      table.startedAt.desc(),
    ),
    startedIdx: index('game_votes_started_idx').on(table.startedAt.desc()),
    initiatorIdx: index('game_votes_initiator_idx')
      .on(table.initiatorPlayerId)
      .where(sql`initiator_player_id IS NOT NULL`),
    typeIdx: index('game_votes_type_idx').on(table.voteType),
    voteTypeCheck: check(
      'game_votes_vote_type_enum',
      sql`vote_type IN ('map_skip','map_change','admin')`,
    ),
    resultCheck: check('game_votes_result_enum', sql`result IN ('passed','failed','cancelled')`),
  }),
);

export type GameVoteRow = typeof gameVotes.$inferSelect;
export type NewGameVote = typeof gameVotes.$inferInsert;

export const gameVoteBallots = pgTable(
  'game_vote_ballots',
  {
    voteId: uuid('vote_id')
      .notNull()
      .references(() => gameVotes.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    choice: text('choice').notNull(),
    votedAt: timestamp('voted_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.voteId, table.playerId] }),
    playerIdx: index('game_vote_ballots_player_idx').on(table.playerId),
    choiceCheck: check('game_vote_ballots_choice_enum', sql`choice IN ('yes','no')`),
  }),
);

export type GameVoteBallotRow = typeof gameVoteBallots.$inferSelect;
export type NewGameVoteBallot = typeof gameVoteBallots.$inferInsert;
