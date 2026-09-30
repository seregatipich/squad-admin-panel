import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Squad's built-in rotation gamemodes. Kept as a plain string column (not a
 * DB enum) so a depot-sync job can ingest gamemodes Squad adds in future
 * updates without a migration.
 */
export const LAYER_GAMEMODES = [
  'RAAS',
  'AAS',
  'Invasion',
  'TC',
  'Skirmish',
  'Destruction',
  'Insurgency',
  'Seed',
] as const;
export type LayerGamemode = (typeof LAYER_GAMEMODES)[number];

/** One side's faction/unit loadout for a layer, when extractable from the layer table. */
export interface LayerTeamInfo {
  faction: string;
  unit?: string;
  tickets?: number;
}

/** Both sides' faction/unit loadout for a layer. Empty object when not (yet) extracted. */
export interface LayerTeams {
  team1?: LayerTeamInfo;
  team2?: LayerTeamInfo;
}

/**
 * layers (ROT-1): catalog of RCON-addressable Squad layers used by the
 * rotation editor (ROT-2), the current/next-map widget (ROT-3), and the
 * rotation calendar (ROT-4).
 *
 * `name` is the exact layer identifier as Squad's RCON expects it for
 * `AdminChangeLayer` / `AdminSetNextLayer` (e.g. "Yehorivka RAAS v11") and is
 * the join key used everywhere else in the panel — there is deliberately no
 * numeric/opaque ID exposed to callers beyond the row's own uuid.
 *
 * Populated by the layer-catalog INSERT in migration 0042
 * (`drizzle/0042_layers_catalog.sql`) so the catalog works without a live depot sync. The depot-sync worker described in
 * the 2026-07-09 map-rotation ADR (docs/architecture/decisions.md) is a
 * follow-up: it will upsert rows by `name`, refresh
 * `depot_version`, and flip `deprecated = true` for layers that disappear
 * from the installed server's layer list after an update.
 */
export const layers = pgTable('layers', {
  id: uuid('id').primaryKey().notNull(),
  name: text('name').notNull().unique(),
  map: text('map').notNull(),
  gamemode: text('gamemode').notNull(),
  version: text('version').notNull(),
  isSeed: boolean('is_seed').notNull().default(false),
  teams: jsonb('teams').notNull().default({}).$type<LayerTeams>(),
  depotVersion: text('depot_version'),
  deprecated: boolean('deprecated').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export type LayerRow = typeof layers.$inferSelect;
export type NewLayer = typeof layers.$inferInsert;
