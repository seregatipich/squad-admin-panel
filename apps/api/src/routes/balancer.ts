import {
  type BalancerProposalRow,
  type BalancerSettingsRow,
  balancerDecisions,
  balancerProposals,
  balancerSettings,
} from '@squad/db/schema';
import {
  BALANCER_DECISIONS,
  BALANCER_PROPOSAL_MODES,
  BALANCER_PROPOSAL_STATUSES,
  BALANCER_VETO_REASON_KINDS,
  type BalancerSignalEvaluation,
  type BalancerThresholds,
  DEFAULT_BALANCER_THRESHOLDS,
  evaluateBalancerSignals,
  readBalancerSignals,
} from '@squad/shared-types';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

const SINGLETON_ID = 1;
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;
const VETO_REASON_MAX = 500;

/** Mirrors the `balancer_settings` column defaults for a panel with no row yet. */
const DEFAULT_SETTINGS = {
  enabled: false,
  win_streak_threshold: DEFAULT_BALANCER_THRESHOLDS.winStreakThreshold,
  ticket_diff_threshold: DEFAULT_BALANCER_THRESHOLDS.ticketDiffThreshold,
  one_sided_rounds_threshold: DEFAULT_BALANCER_THRESHOLDS.oneSidedRoundsThreshold,
  quorum: 5,
  pass_threshold_pct: 60,
  require_moderator_veto: false,
  prefer_squad_grouping: true,
  player_level_enabled: false,
} as const;

const putBody = z
  .object({
    enabled: z.boolean().optional(),
    win_streak_threshold: z.number().int().min(1).max(100).optional(),
    ticket_diff_threshold: z.number().int().min(0).max(10_000).optional(),
    one_sided_rounds_threshold: z.number().int().min(1).max(100).optional(),
    quorum: z.number().int().min(0).max(100).optional(),
    pass_threshold_pct: z.number().int().min(0).max(100).optional(),
    require_moderator_veto: z.boolean().optional(),
    prefer_squad_grouping: z.boolean().optional(),
    player_level_enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

const listQuery = z.object({
  server_id: z.union([z.string().uuid(), z.literal('all')]).optional(),
  status: z.enum(BALANCER_PROPOSAL_STATUSES).optional(),
  mode: z.enum(BALANCER_PROPOSAL_MODES).optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

const decisionBody = z.object({
  decision: z.enum(BALANCER_DECISIONS),
  veto_reason_kind: z.enum(BALANCER_VETO_REASON_KINDS).optional(),
  veto_reason: z.string().trim().min(1).max(VETO_REASON_MAX).optional(),
});

interface BalancerSettingsView {
  enabled: boolean;
  win_streak_threshold: number;
  ticket_diff_threshold: number;
  one_sided_rounds_threshold: number;
  quorum: number;
  pass_threshold_pct: number;
  require_moderator_veto: boolean;
  prefer_squad_grouping: boolean;
  player_level_enabled: boolean;
  updated_at: string | null;
  updated_by_player_id: string | null;
}

function serializeSettings(row: BalancerSettingsRow | null): BalancerSettingsView {
  if (!row) return { ...DEFAULT_SETTINGS, updated_at: null, updated_by_player_id: null };
  return {
    enabled: row.enabled,
    win_streak_threshold: row.winStreakThreshold,
    ticket_diff_threshold: row.ticketDiffThreshold,
    one_sided_rounds_threshold: row.oneSidedRoundsThreshold,
    quorum: row.quorum,
    pass_threshold_pct: row.passThresholdPct,
    require_moderator_veto: row.requireModeratorVeto,
    prefer_squad_grouping: row.preferSquadGrouping,
    player_level_enabled: row.playerLevelEnabled,
    updated_at: row.updatedAt.toISOString(),
    updated_by_player_id: row.updatedByPlayerId,
  };
}

function thresholdsOf(row: BalancerSettingsRow | null): BalancerThresholds {
  if (!row) return DEFAULT_BALANCER_THRESHOLDS;
  return {
    winStreakThreshold: row.winStreakThreshold,
    ticketDiffThreshold: row.ticketDiffThreshold,
    oneSidedRoundsThreshold: row.oneSidedRoundsThreshold,
  };
}

interface BalancerProposalView {
  id: string;
  source_snapshot_id: string;
  server_id: string;
  match_id: string | null;
  layer: string | null;
  gamemode: string | null;
  mode: string;
  schema_version: number;
  status: string;
  generated_at: string;
  received_at: string;
  signals: unknown;
  proposal: unknown;
  evaluation: BalancerSignalEvaluation;
}

function serializeProposal(
  row: BalancerProposalRow,
  thresholds: BalancerThresholds,
): BalancerProposalView {
  return {
    id: row.id,
    source_snapshot_id: row.sourceSnapshotId,
    server_id: row.serverId,
    match_id: row.matchId,
    layer: row.layer,
    gamemode: row.gamemode,
    mode: row.mode,
    schema_version: row.schemaVersion,
    status: row.status,
    generated_at: row.generatedAt.toISOString(),
    received_at: row.receivedAt.toISOString(),
    signals: row.signals,
    proposal: row.proposal,
    evaluation: evaluateBalancerSignals(thresholds, readBalancerSignals(row.signals)),
  };
}

function encodeCursor(row: { generatedAt: Date; id: string }): string {
  return `${row.generatedAt.getTime()}_${row.id}`;
}

function parseCursor(raw: string): { generatedAt: Date; id: string } | null {
  const sep = raw.indexOf('_');
  if (sep === -1) return null;
  const millis = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(millis) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { generatedAt: new Date(millis), id };
}

/**
 * A decision's effect on the snapshot's review status. `acknowledge` and `veto`
 * both mean "an operator has looked at this"; only `dismiss` takes it off the
 * board. Nothing here reaches a live server.
 */
const STATUS_AFTER_DECISION = {
  acknowledge: 'reviewed',
  veto: 'reviewed',
  dismiss: 'dismissed',
} as const;

/**
 * GAME-2 (#81) balancer review + rules API.
 *
 * Read routes are gated on `balancer:view`, writes on `balancer:edit`, both
 * enforced declaratively by the `onRequest` hook in `plugins/auth.ts`. Snapshots
 * are ingested by the separate `integrations-balancer.ts` webhook module; this
 * module only reads them, evaluates them against the operator's thresholds, and
 * records decisions. It never enqueues an RCON command.
 */
const balancerRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadSettings(): Promise<BalancerSettingsRow | null> {
    const rows = await app.db
      .select()
      .from(balancerSettings)
      .where(eq(balancerSettings.id, SINGLETON_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  fast.get(
    '/api/v1/balancer/settings',
    { config: { permissions: ['balancer:view'], audit: false } },
    async () => ({ settings: serializeSettings(await loadSettings()) }),
  );

  fast.put(
    '/api/v1/balancer/settings',
    {
      schema: { body: putBody },
      config: {
        permissions: ['balancer:edit'],
        audit: { action: 'balancer.settings.update', resource: 'balancer_settings' },
      },
    },
    async (req, reply) => {
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const body = req.body;
      const updates: Partial<typeof balancerSettings.$inferInsert> = {
        updatedByPlayerId: actorId,
        updatedAt: new Date(),
      };
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.win_streak_threshold !== undefined) {
        updates.winStreakThreshold = body.win_streak_threshold;
      }
      if (body.ticket_diff_threshold !== undefined) {
        updates.ticketDiffThreshold = body.ticket_diff_threshold;
      }
      if (body.one_sided_rounds_threshold !== undefined) {
        updates.oneSidedRoundsThreshold = body.one_sided_rounds_threshold;
      }
      if (body.quorum !== undefined) updates.quorum = body.quorum;
      if (body.pass_threshold_pct !== undefined) {
        updates.passThresholdPct = body.pass_threshold_pct;
      }
      if (body.require_moderator_veto !== undefined) {
        updates.requireModeratorVeto = body.require_moderator_veto;
      }
      if (body.prefer_squad_grouping !== undefined) {
        updates.preferSquadGrouping = body.prefer_squad_grouping;
      }
      if (body.player_level_enabled !== undefined) {
        updates.playerLevelEnabled = body.player_level_enabled;
      }

      await app.db
        .insert(balancerSettings)
        .values({ id: SINGLETON_ID, ...updates })
        .onConflictDoUpdate({ target: balancerSettings.id, set: updates });

      return { settings: serializeSettings(await loadSettings()) };
    },
  );

  fast.get(
    '/api/v1/balancer/proposals',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['balancer:view'], audit: false },
    },
    async (req, reply) => {
      const limit = req.query.limit ?? PAGE_SIZE_DEFAULT;
      const clauses: SQL[] = [];
      if (req.query.server_id && req.query.server_id !== 'all') {
        clauses.push(eq(balancerProposals.serverId, req.query.server_id));
      }
      if (req.query.status) clauses.push(eq(balancerProposals.status, req.query.status));
      if (req.query.mode) clauses.push(eq(balancerProposals.mode, req.query.mode));

      if (req.query.cursor) {
        const parsed = parseCursor(req.query.cursor);
        if (!parsed) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        clauses.push(
          or(
            lt(balancerProposals.generatedAt, parsed.generatedAt),
            and(
              eq(balancerProposals.generatedAt, parsed.generatedAt),
              lt(balancerProposals.id, parsed.id),
            ),
          ) as SQL,
        );
      }

      const rows = await app.db
        .select()
        .from(balancerProposals)
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(desc(balancerProposals.generatedAt), desc(balancerProposals.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const thresholds = thresholdsOf(await loadSettings());

      return {
        items: page.map((row) => serializeProposal(row, thresholds)),
        next_cursor: hasMore && last ? encodeCursor(last) : null,
      };
    },
  );

  fast.get(
    '/api/v1/balancer/proposals/:id',
    {
      schema: { params: idParam },
      config: { permissions: ['balancer:view'], audit: false },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(balancerProposals)
        .where(eq(balancerProposals.id, req.params.id))
        .limit(1);
      if (!row) {
        reply.code(404);
        return { error: 'proposal_not_found' };
      }

      const decisions = await app.db
        .select()
        .from(balancerDecisions)
        .where(eq(balancerDecisions.proposalId, row.id))
        .orderBy(desc(balancerDecisions.createdAt), desc(balancerDecisions.id));

      return {
        ...serializeProposal(row, thresholdsOf(await loadSettings())),
        decisions: decisions.map((decision) => ({
          id: decision.id,
          decision: decision.decision,
          veto_reason_kind: decision.vetoReasonKind,
          veto_reason: decision.vetoReason,
          decided_by_player_id: decision.decidedByPlayerId,
          created_at: decision.createdAt.toISOString(),
        })),
      };
    },
  );

  fast.post(
    '/api/v1/balancer/proposals/:id/decision',
    {
      schema: { params: idParam, body: decisionBody },
      config: {
        permissions: ['balancer:edit'],
        audit: { action: 'balancer.proposal.decision', resource: 'balancer_proposal' },
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (body.decision === 'veto' && !body.veto_reason) {
        reply.code(400);
        return { error: 'veto_reason_required' };
      }

      const [proposal] = await app.db
        .select({ id: balancerProposals.id })
        .from(balancerProposals)
        .where(eq(balancerProposals.id, req.params.id))
        .limit(1);
      if (!proposal) {
        reply.code(404);
        return { error: 'proposal_not_found' };
      }

      const status = STATUS_AFTER_DECISION[body.decision];
      const decisionId = uuidv7();
      await app.db.transaction(async (tx) => {
        await tx.insert(balancerDecisions).values({
          id: decisionId,
          proposalId: proposal.id,
          decision: body.decision,
          vetoReasonKind: body.veto_reason_kind ?? null,
          vetoReason: body.veto_reason ?? null,
          decidedByPlayerId: req.user?.playerId ?? null,
        });
        await tx
          .update(balancerProposals)
          .set({ status })
          .where(eq(balancerProposals.id, proposal.id));
      });

      reply.code(201);
      return {
        id: decisionId,
        proposal_id: proposal.id,
        decision: body.decision,
        veto_reason_kind: body.veto_reason_kind ?? null,
        veto_reason: body.veto_reason ?? null,
        status,
      };
    },
  );
};

export default balancerRoutes;
