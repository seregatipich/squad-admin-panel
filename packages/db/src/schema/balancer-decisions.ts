import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { balancerProposals } from './balancer-proposals.js';
import { players } from './players.js';

/** Operator verdicts recorded against a snapshot (see `@squad/shared-types`). */
export type BalancerDecisionValue = 'acknowledge' | 'veto' | 'dismiss';
/** Structured reason categories accompanying a `veto`. */
export type BalancerVetoReasonKindValue = 'seeding' | 'event' | 'clan_match' | 'other';

/**
 * balancer_decisions (GAME-2, #81): append-only audit trail of what an operator
 * decided about a {@link balancerProposals} snapshot. Modelled on
 * `automation_runs` — rows are never updated or deleted, so the full review
 * history of a snapshot survives even after its status settles.
 *
 * A `veto` must carry a free-text `veto_reason`; the CHECK enforces that at the
 * storage layer so the rule holds for any writer, not just the API route that
 * returns `400 veto_reason_required`. `veto_reason_kind` is the optional
 * structured category alongside it.
 *
 * Every insert is additionally mirrored into `audit_log` as
 * `balancer.proposal.decision` by the route's declarative `config.audit`.
 */
export const balancerDecisions = pgTable(
  'balancer_decisions',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => balancerProposals.id, { onDelete: 'cascade' }),
    decision: text('decision').$type<BalancerDecisionValue>().notNull(),
    vetoReasonKind: text('veto_reason_kind').$type<BalancerVetoReasonKindValue>(),
    vetoReason: text('veto_reason'),
    decidedByPlayerId: uuid('decided_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    decisionChk: check(
      'balancer_decisions_decision_check',
      sql`${table.decision} IN ('acknowledge','veto','dismiss')`,
    ),
    vetoReasonKindChk: check(
      'balancer_decisions_veto_reason_kind_check',
      sql`${table.vetoReasonKind} IS NULL OR ${table.vetoReasonKind} IN ('seeding','event','clan_match','other')`,
    ),
    vetoReasonRequired: check(
      'balancer_decisions_veto_reason_required',
      sql`${table.decision} <> 'veto' OR ${table.vetoReason} IS NOT NULL`,
    ),
    proposalIdx: index('balancer_decisions_proposal_idx').on(
      table.proposalId,
      table.createdAt.desc(),
    ),
  }),
);

export type BalancerDecisionRow = typeof balancerDecisions.$inferSelect;
export type NewBalancerDecision = typeof balancerDecisions.$inferInsert;
