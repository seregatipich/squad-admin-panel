import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

export const COMBAT_EVENT_TYPES = [
  'death',
  'damage',
  'wound',
  'revive',
  'vehicle_destroyed',
] as const;
export type CombatEventType = (typeof COMBAT_EVENT_TYPES)[number];

export const combatEvents = pgTable(
  'combat_events',
  {
    id: bigint('id', { mode: 'bigint' }).notNull().generatedAlwaysAsIdentity(),
    eventType: text('event_type').notNull(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    matchId: bigint('match_id', { mode: 'bigint' }),
    attackerPlayerId: uuid('attacker_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    victimPlayerId: uuid('victim_player_id').references(() => players.id, {
      onDelete: 'cascade',
    }),
    victimVehicle: text('victim_vehicle'),
    attackerVehicle: text('attacker_vehicle'),
    weapon: text('weapon'),
    damage: numeric('damage'),
    attackerKit: text('attacker_kit'),
    isTeamkill: boolean('is_teamkill').notNull().default(false),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.occurredAt] }),
    serverOccurredIdx: index('combat_events_server_occurred_idx').on(
      table.serverId,
      table.occurredAt.desc(),
    ),
    attackerOccurredIdx: index('combat_events_attacker_occurred_idx').on(
      table.attackerPlayerId,
      table.occurredAt.desc(),
    ),
    victimOccurredIdx: index('combat_events_victim_occurred_idx').on(
      table.victimPlayerId,
      table.occurredAt.desc(),
    ),
    teamkillVictimIdx: index('combat_events_teamkill_victim_idx')
      .on(table.victimPlayerId, table.occurredAt.desc())
      .where(sql`is_teamkill`),
    occurredAtBrinIdx: index('combat_events_occurred_at_brin_idx')
      .using('brin', table.occurredAt)
      .with({ pages_per_range: 32 }),
    eventTypeChk: check(
      'combat_events_event_type_chk',
      sql`event_type IN ('death','damage','wound','revive','vehicle_destroyed')`,
    ),
  }),
);

export type CombatEventRow = typeof combatEvents.$inferSelect;
export type NewCombatEvent = typeof combatEvents.$inferInsert;
