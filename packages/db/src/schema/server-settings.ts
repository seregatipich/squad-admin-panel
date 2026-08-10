import { boolean, inet, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { MapVoteSelection } from './map-vote.js';
import { servers } from './servers.js';

export const serverSettings = pgTable('server_settings', {
  serverId: uuid('server_id')
    .primaryKey()
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  installPath: text('install_path').notNull(),
  gamePort: integer('game_port').notNull(),
  queryPort: integer('query_port').notNull(),
  beaconPort: integer('beacon_port').notNull(),
  rconPort: integer('rcon_port').notNull(),
  maxPlayers: integer('max_players').notNull().default(100),
  tickrate: integer('tickrate').notNull().default(50),
  multihome: inet('multihome'),
  extraArgs: text('extra_args').notNull().default(''),
  launchArgsOverride: text('launch_args_override'),
  cpuAffinity: text('cpu_affinity'),
  cpuWeight: integer('cpu_weight'),
  niceness: integer('niceness'),
  memoryHighMb: integer('memory_high_mb'),
  memoryMaxMb: integer('memory_max_mb'),
  ioWeight: integer('io_weight'),
  /** Player count at which the server is considered "live" (out of seeding). See SEED-1 (#140). */
  seedLiveAt: integer('seed_live_at').notNull().default(60),
  /** Hysteresis band (players) around seedLiveAt to avoid flapping at the boundary. See SEED-1 (#140). */
  seedHysteresis: integer('seed_hysteresis').notNull().default(5),
  /**
   * Whether AUTO-4 in-game chat commands (`!stats`/`!rules`/`!report`) are
   * answered for this server. Lets operators disable panel-owned chat commands
   * where an RNSquadJS sidecar runs its own `chatCommands`. See AUTO-4 (#75).
   */
  chatCommandsEnabled: boolean('chat_commands_enabled').notNull().default(true),
  /** Text returned in-game for the `!rules` command; null = not configured. See AUTO-4 (#75). */
  rulesText: text('rules_text'),
  /**
   * When true, a rotated `SquadGame*.log` about to be deleted by the LOG-1
   * 10-day retention sweep is first copied into the restic backup staging tree
   * so the next snapshot archives it under the existing 7d/4w/6m retention.
   * Default false keeps the server on the current delete-only path. See LOG-3 (#51).
   */
  archiveLogsToBackup: boolean('archive_logs_to_backup').notNull().default(false),
  /** Master switch for the GAME-1 (#80) map auto-selection tick. */
  mapVoteEnabled: boolean('map_vote_enabled').notNull().default(false),
  /**
   * GAME-1 selection rule applied by the scheduler tick. The allowed values
   * are enforced by `server_settings_map_vote_selection_check` in migration
   * 0090 (this table has no extras callback for a drizzle-side CHECK).
   */
  mapVoteSelection: text('map_vote_selection')
    .$type<MapVoteSelection>()
    .notNull()
    .default('weighted_random'),
  /** GAME-1: a layer played within the last N non-seed matches is excluded. */
  mapVoteLayerCooldown: integer('map_vote_layer_cooldown').notNull().default(3),
  /** GAME-1: a map played within the last N non-seed matches is excluded. */
  mapVoteMapCooldown: integer('map_vote_map_cooldown').notNull().default(2),
  /** Optional broadcast template announcing the GAME-1 pick; null = no broadcast configured. */
  mapVoteBroadcastTemplate: text('map_vote_broadcast_template'),
});

export type ServerSettingsRow = typeof serverSettings.$inferSelect;
export type NewServerSettings = typeof serverSettings.$inferInsert;
