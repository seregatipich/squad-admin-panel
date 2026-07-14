import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/**
 * seed_schedule (SEED-3, #142): planned seed-layer starts for a server —
 * a one-off `starts_at` or a recurring 5-field cron expression
 * (`recurrence`, evaluated in UTC by `@squad/shared-types`'s `cron5.ts`)
 * — executed by `@squad/worker-scheduler` (`runSeedScheduleTick`), which
 * fires `AdminSetNextLayer`/`AdminChangeLayer` (plus an optional
 * `AdminBroadcast`) via the worker-rcon command stream, per SEED-1's
 * live/seeding redis state.
 *
 * `seedLayer` must reference a `layers.name` row with `isSeed = true`
 * (checked at the API layer, not by a DB FK, since the layers catalog is
 * keyed by name not id — see `packages/db/src/schema/layers.ts`).
 *
 * `lastExecutedAt` is the execution-dedup cursor: for a one-off entry it is
 * set once the entry fires (never fires again); for a recurring entry the
 * scheduler tick fires every cron occurrence strictly after
 * `lastExecutedAt` (or `createdAt` if never yet executed) up to "now".
 */
export const seedSchedule = pgTable(
  'seed_schedule',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    seedLayer: text('seed_layer').notNull(),
    broadcastText: text('broadcast_text'),
    /** 5-field cron expression (minute hour day-of-month month day-of-week), UTC. Null = one-off. */
    recurrence: text('recurrence'),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverStartsIdx: index('seed_schedule_server_starts_idx').on(table.serverId, table.startsAt),
  }),
);

export type SeedScheduleRow = typeof seedSchedule.$inferSelect;
export type NewSeedSchedule = typeof seedSchedule.$inferInsert;
