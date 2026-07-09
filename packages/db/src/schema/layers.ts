import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Squad's built-in rotation gamemodes. Kept as a plain string column (not a
 * DB enum) so a depot-sync job (see ai_docs/adr/2026-07-09-map-rotation-managed-vs-native.md)
 * can ingest gamemodes Squad adds in future updates without a migration.
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
 * Populated from the static fallback dataset below (`LAYERS_SEED`) so the
 * catalog works without a live depot sync. The depot-sync worker described in
 * the ADR is a follow-up: it will upsert rows by `name`, refresh
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

/** Squad version the static fallback dataset below was captured for. */
export const LAYERS_SEED_DEPOT_VERSION = 'v7.5';

export interface LayerSeed {
  name: string;
  map: string;
  gamemode: LayerGamemode;
  version: string;
  isSeed: boolean;
  teams: LayerTeams;
}

/**
 * Static fallback layer dataset for `LAYERS_SEED_DEPOT_VERSION`. Covers a
 * representative slice of maps/gamemodes (including Seed layers) so the
 * catalog and its API filters work out of the box, without waiting on the
 * depot-sync job. Not exhaustive — the depot sync is expected to supersede
 * and expand this list once implemented.
 */
export const LAYERS_SEED: readonly LayerSeed[] = [
  {
    name: 'Sumari Bala AAS v1',
    map: 'Sumari Bala',
    gamemode: 'AAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'MEA' } },
  },
  {
    name: "Fool's Road AAS v1",
    map: "Fool's Road",
    gamemode: 'AAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'USA' }, team2: { faction: 'RGF' } },
  },
  {
    name: 'Gorodok RAAS v1',
    map: 'Gorodok',
    gamemode: 'RAAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'USA' } },
  },
  {
    name: 'Yehorivka RAAS v11',
    map: 'Yehorivka',
    gamemode: 'RAAS',
    version: 'v11',
    isSeed: false,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'USA' } },
  },
  {
    name: 'Al Basrah Invasion v3',
    map: 'Al Basrah',
    gamemode: 'Invasion',
    version: 'v3',
    isSeed: false,
    teams: { team1: { faction: 'MEA' }, team2: { faction: 'INS' } },
  },
  {
    name: 'Belaya Pass RAAS v1',
    map: 'Belaya Pass',
    gamemode: 'RAAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'BAF' } },
  },
  {
    name: 'Mestia RAAS v1',
    map: 'Mestia',
    gamemode: 'RAAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'TLF' }, team2: { faction: 'ADF' } },
  },
  {
    name: 'Narva Skirmish v1',
    map: 'Narva',
    gamemode: 'Skirmish',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'BAF' }, team2: { faction: 'RGF' } },
  },
  {
    name: 'Tallil Outskirts Destruction v1',
    map: 'Tallil Outskirts',
    gamemode: 'Destruction',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'USA' }, team2: { faction: 'MEA' } },
  },
  {
    name: 'Mutaha TC v1',
    map: 'Mutaha',
    gamemode: 'TC',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'USMC' }, team2: { faction: 'INS' } },
  },
  {
    name: 'Kohat Toi RAAS v2',
    map: 'Kohat Toi',
    gamemode: 'RAAS',
    version: 'v2',
    isSeed: false,
    teams: { team1: { faction: 'USA' }, team2: { faction: 'IMF' } },
  },
  {
    name: 'Black Coast RAAS v2',
    map: 'Black Coast',
    gamemode: 'RAAS',
    version: 'v2',
    isSeed: false,
    teams: { team1: { faction: 'PLA' }, team2: { faction: 'ADF' } },
  },
  {
    name: 'Harju Skirmish v1',
    map: 'Harju',
    gamemode: 'Skirmish',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'USA' }, team2: { faction: 'RGF' } },
  },
  {
    name: 'Chora RAAS v1',
    map: 'Chora',
    gamemode: 'RAAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'CAF' }, team2: { faction: 'INS' } },
  },
  {
    name: 'Anvil RAAS v1',
    map: 'Anvil',
    gamemode: 'RAAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'WPMC' }, team2: { faction: 'VDV' } },
  },
  {
    name: 'Manicouagan RAAS v1',
    map: 'Manicouagan',
    gamemode: 'RAAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'CAF' }, team2: { faction: 'RGF' } },
  },
  {
    name: 'Lashkar Valley Insurgency v1',
    map: 'Lashkar Valley',
    gamemode: 'Insurgency',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'USA' }, team2: { faction: 'INS' } },
  },
  {
    name: 'Kamdesh Highlands RAAS v1',
    map: 'Kamdesh Highlands',
    gamemode: 'RAAS',
    version: 'v1',
    isSeed: false,
    teams: { team1: { faction: 'USA' }, team2: { faction: 'IMF' } },
  },
  {
    name: 'Sumari Seed v1',
    map: 'Sumari Bala',
    gamemode: 'Seed',
    version: 'v1',
    isSeed: true,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'MEA' } },
  },
  {
    name: 'Narva Seed v1',
    map: 'Narva',
    gamemode: 'Seed',
    version: 'v1',
    isSeed: true,
    teams: { team1: { faction: 'BAF' }, team2: { faction: 'RGF' } },
  },
  {
    name: 'Belaya Seed v1',
    map: 'Belaya Pass',
    gamemode: 'Seed',
    version: 'v1',
    isSeed: true,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'BAF' } },
  },
  {
    name: 'Gorodok Seed v1',
    map: 'Gorodok',
    gamemode: 'Seed',
    version: 'v1',
    isSeed: true,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'USA' } },
  },
  {
    name: 'Yehorivka Seed v1',
    map: 'Yehorivka',
    gamemode: 'Seed',
    version: 'v1',
    isSeed: true,
    teams: { team1: { faction: 'RGF' }, team2: { faction: 'USA' } },
  },
  {
    name: 'Mutaha Seed v1',
    map: 'Mutaha',
    gamemode: 'Seed',
    version: 'v1',
    isSeed: true,
    teams: { team1: { faction: 'USMC' }, team2: { faction: 'INS' } },
  },
] as const;
