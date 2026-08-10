import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { matches } from './matches.js';
import { servers } from './servers.js';

/**
 * Granularity of a stored snapshot. Canonical list (with the evaluation engine
 * that consumes it) lives in `@squad/shared-types`' `balancer.ts`; `@squad/db`
 * does not depend on that package, so the union is restated here exactly as
 * `automation-rules.ts` restates its own condition/action unions.
 */
export type BalancerProposalModeValue = 'squad' | 'player';
/** Deterministic diff state of one subject; drives the review UI's row colour. */
export type BalancerProposalStateValue = 'on_target' | 'no_change' | 'should_move';
/** What a single diff row addresses. */
export type BalancerSubjectTypeValue = 'squad' | 'group' | 'player';
/** Review lifecycle of a stored snapshot. */
export type BalancerProposalStatusValue = 'open' | 'reviewed' | 'dismissed' | 'superseded';

/** One diff row inside the `proposal` jsonb array. */
export interface BalancerProposalEntry {
  subject_type: BalancerSubjectTypeValue;
  subject_id: string;
  label: string;
  current_team: number | null;
  target_team: number | null;
  state: BalancerProposalStateValue;
}

/**
 * balancer_proposals (GAME-2, #81): review cache of the dry-run balance
 * snapshots produced by the upstream SquadJS exporter and delivered to the
 * panel over the HMAC-signed webhook
 * `POST /api/v1/integrations/balancer/proposals`.
 *
 * `source_snapshot_id` is the producer-supplied idempotency key (unique, like
 * `vip_lifecycle_events.event_id`): re-delivering the same snapshot updates the
 * stored row rather than creating a second one. When a *new* snapshot arrives
 * for the same `(server_id, mode)` pair, the previous still-`open` row is
 * flipped to `superseded`, so the review UI always has exactly one current
 * snapshot per granularity.
 *
 * `signals` and `proposal` are raw `jsonb` blobs carrying whatever the exporter
 * emitted, versioned by `schema_version`. That is deliberate: the exporter's
 * wire format is not pinned on the panel side yet, and storing it opaquely
 * means a payload change is a value change, never a migration. The panel reads
 * `signals` through the tolerant `readBalancerSignals` helper in
 * `@squad/shared-types`, which treats any missing or malformed field as an
 * unevaluated signal.
 *
 * A row here is a *proposal*, never an instruction: nothing in this table is
 * ever executed against a live server. Live team changes are out of scope for
 * #81 and would need a new `RCON_OPERATOR_COMMANDS` entry.
 */
export const balancerProposals = pgTable(
  'balancer_proposals',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    sourceSnapshotId: text('source_snapshot_id').notNull(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    matchId: uuid('match_id').references(() => matches.id, { onDelete: 'set null' }),
    layer: text('layer'),
    gamemode: text('gamemode'),
    mode: text('mode').$type<BalancerProposalModeValue>().notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' }).notNull(),
    signals: jsonb('signals').notNull().default({}),
    proposal: jsonb('proposal').$type<BalancerProposalEntry[]>().notNull().default([]),
    status: text('status').$type<BalancerProposalStatusValue>().notNull().default('open'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    modeChk: check('balancer_proposals_mode_check', sql`${table.mode} IN ('squad','player')`),
    statusChk: check(
      'balancer_proposals_status_check',
      sql`${table.status} IN ('open','reviewed','dismissed','superseded')`,
    ),
    schemaVersionChk: check(
      'balancer_proposals_schema_version_check',
      sql`${table.schemaVersion} >= 1`,
    ),
    sourceSnapshotKey: uniqueIndex('balancer_proposals_source_snapshot_key').on(
      table.sourceSnapshotId,
    ),
    serverGeneratedIdx: index('balancer_proposals_server_generated_idx').on(
      table.serverId,
      table.generatedAt.desc(),
    ),
    statusIdx: index('balancer_proposals_status_idx').on(table.status, table.generatedAt.desc()),
  }),
);

export type BalancerProposalRow = typeof balancerProposals.$inferSelect;
export type NewBalancerProposal = typeof balancerProposals.$inferInsert;
