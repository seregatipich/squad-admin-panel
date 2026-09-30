import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const events = pgTable(
  'events',
  {
    eventId: uuid('event_id').notNull(),
    serverId: uuid('server_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    kind: text('kind').notNull(),
    version: integer('version').notNull().default(1),
    actorKind: text('actor_kind'),
    actorId: text('actor_id'),
    correlationId: uuid('correlation_id'),
    payload: jsonb('payload').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.eventId, table.occurredAt] }),
    serverOccurredIdx: index('events_server_occurred_idx').on(table.serverId, table.occurredAt),
    // Matches the partial index actually created by 0000_init.sql: it only
    // covers the RCON-poll/connect/disconnect kinds it was built for, not every
    // `kind`. Declaring it as a full index here drifted from that DDL and hid
    // the fact that seeding lookups (SEEDING_EVENT_KINDS) were never indexed
    // (#1324); see events-seeding-kind.sql for their own partial index.
    kindOccurredIdx: index('events_kind_occurred_idx')
      .on(table.kind, table.occurredAt)
      .where(sql`kind IN ('player.connected','player.disconnected','rcon.players_polled')`),
    // Partial index for the seeding lookups. `INCLUDE (server_id)` from
    // 0127_events_indexes.sql cannot be expressed by drizzle-orm's index builder.
    seedingKindOccurredIdx: index('events_seeding_kind_occurred_idx')
      .on(table.kind, table.occurredAt.desc())
      .where(sql`kind IN ('server.seeding_started', 'server.seeding_ended')`),
    occurredAtEventIdIdx: index('events_occurred_at_event_id_idx').on(
      table.occurredAt.desc(),
      table.eventId.desc(),
    ),
    ruleIdIdx: index('events_rule_id_idx')
      .on(sql`(${table.payload} ->> 'rule_id')`)
      .where(sql`(${table.payload} ->> 'rule_id') IS NOT NULL`),
    actorOccurredIdx: index('events_actor_occurred_idx')
      .on(table.actorId, table.occurredAt.desc())
      .where(sql`${table.actorId} IS NOT NULL`),
  }),
);

export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

/**
 * Consumer-side idempotency claims: one row per persisted event id. Rows older
 * than the `events` retention window are deleted by worker-event-partition
 * (`pruneProcessedEvents`), whose delete `processed_at_idx` serves; by then the
 * event itself is gone, so there is nothing left to deduplicate against.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').primaryKey().notNull(),
    groupName: text('group_name').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    processedAtIdx: index('processed_events_processed_at_idx').on(table.processedAt),
  }),
);

export type ProcessedEventRow = typeof processedEvents.$inferSelect;
export type NewProcessedEvent = typeof processedEvents.$inferInsert;
