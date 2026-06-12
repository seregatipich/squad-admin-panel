import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const diagnosticEvents = pgTable(
  'diagnostic_events',
  {
    id: uuid('id').notNull(),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull(),
    component: text('component').notNull(),
    severity: text('severity').notNull(),
    kind: text('kind').notNull(),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
    actorPlayerId: uuid('actor_player_id'),
    requestId: text('request_id'),
    message: text('message').notNull(),
    payload: jsonb('payload').notNull().default({}),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.ts] }),
    tsIdx: index('diagnostic_events_ts_idx').on(table.ts),
    serverTsIdx: index('diagnostic_events_server_ts_idx').on(table.serverId, table.ts),
    kindTsIdx: index('diagnostic_events_kind_ts_idx').on(table.component, table.severity, table.ts),
    severityChk: check(
      'diagnostic_events_severity_chk',
      sql`severity IN ('debug','info','warn','error','fatal')`,
    ),
  }),
);

export type DiagnosticEventRow = typeof diagnosticEvents.$inferSelect;
export type NewDiagnosticEvent = typeof diagnosticEvents.$inferInsert;
