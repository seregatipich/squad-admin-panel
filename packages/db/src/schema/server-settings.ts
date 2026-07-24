import { boolean, inet, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
});

export type ServerSettingsRow = typeof serverSettings.$inferSelect;
export type NewServerSettings = typeof serverSettings.$inferInsert;
