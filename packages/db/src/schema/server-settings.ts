import { inet, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
});

export type ServerSettingsRow = typeof serverSettings.$inferSelect;
export type NewServerSettings = typeof serverSettings.$inferInsert;
