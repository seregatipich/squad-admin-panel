import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { matches } from './matches.js';
import { players } from './players.js';
import { servers } from './servers.js';

/**
 * Selection rules for GAME-1 (#80) panel-driven map auto-selection — see
 * ai_docs/adr/2026-07-09-map-rotation-managed-vs-native.md ("automatic
 * voting" is reframed as candidate selection + `AdminSetNextLayer`).
 */
export const MAP_VOTE_SELECTIONS = ['weighted_random', 'least_recently_played'] as const;
export type MapVoteSelection = (typeof MAP_VOTE_SELECTIONS)[number];

/**
 * Per-server candidate pool for the GAME-1 auto-selection tick. `layer` is a
 * `layers.name` catalog value validated at write time by the API; `weight`
 * (1..100) drives the weighted-random rule.
 */
export const mapVoteCandidates = pgTable(
  'map_vote_candidates',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    layer: text('layer').notNull(),
    weight: integer('weight').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverLayerKey: uniqueIndex('map_vote_candidates_server_layer_key').on(
      table.serverId,
      table.layer,
    ),
    serverEnabledIdx: index('map_vote_candidates_server_enabled_idx')
      .on(table.serverId)
      .where(sql`enabled`),
    weightCheck: check('map_vote_candidates_weight_check', sql`weight >= 1 AND weight <= 100`),
  }),
);

export type MapVoteCandidateRow = typeof mapVoteCandidates.$inferSelect;
export type NewMapVoteCandidate = typeof mapVoteCandidates.$inferInsert;

/**
 * One auto-selection decision per match (GAME-1). The unique `match_id` index
 * is the tick's idempotency guard: `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING` returning no row means another tick already owns the match.
 * `candidate_snapshot` records the pool the rule saw; `rng_seed` makes the
 * weighted-random pick reproducible.
 */
export const mapVotePicks = pgTable(
  'map_vote_picks',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    layer: text('layer').notNull(),
    selection: text('selection').$type<MapVoteSelection>().notNull(),
    candidateSnapshot: jsonb('candidate_snapshot').notNull().default([]),
    rngSeed: text('rng_seed'),
    applied: boolean('applied').notNull().default(false),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    matchKey: uniqueIndex('map_vote_picks_match_key').on(table.matchId),
    serverCreatedIdx: index('map_vote_picks_server_created_idx').on(
      table.serverId,
      table.createdAt.desc(),
    ),
    selectionCheck: check(
      'map_vote_picks_selection_check',
      sql`selection IN ('weighted_random','least_recently_played')`,
    ),
  }),
);

export type MapVotePickRow = typeof mapVotePicks.$inferSelect;
export type NewMapVotePick = typeof mapVotePicks.$inferInsert;
