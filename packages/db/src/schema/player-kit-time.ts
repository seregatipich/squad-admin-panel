import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/**
 * Per-player, per-kit, per-server accrued playtime (DOSSIER-3, issue #190).
 *
 * Accumulated by worker-rcon from periodic `ListPlayers` polling (RCON-1):
 * each poll interval a player spends holding a given kit accrues its elapsed
 * seconds here. `kit` is the faction-stripped, normalized role name produced
 * by `normalizeRoleName` (`@squad/shared-config`) — never the raw per-faction
 * Squad role-string (e.g. `USA_Medic_01` and `RGF_Medic_01` both accrue under
 * `kit = 'Medic'`). This is an independent, time-based counterpart to the
 * RNSquadJS kit-usage counts (STATS-4) and feeds the player-profile "Kits"
 * tab (DOSSIER-6). Retention is indefinite.
 */
export const playerKitTime = pgTable(
  'player_kit_time',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    kit: text('kit').notNull(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    seconds: bigint('seconds', { mode: 'number' }).notNull().default(0),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playerId, table.kit, table.serverId] }),
    secondsChk: check('player_kit_time_seconds_chk', sql`seconds >= 0`),
    playerIdIdx: index('player_kit_time_player_id_idx').on(table.playerId),
  }),
);

export type PlayerKitTimeRow = typeof playerKitTime.$inferSelect;
export type NewPlayerKitTime = typeof playerKitTime.$inferInsert;
