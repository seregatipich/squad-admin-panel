import { type BalancerProposalEntry, balancerProposals, servers } from '@squad/db/schema';
import {
  BALANCER_PROPOSAL_MODES,
  BALANCER_PROPOSAL_STATES,
  BALANCER_SCHEMA_VERSION,
  BALANCER_SUBJECT_TYPES,
} from '@squad/shared-types';
import { and, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifyBalancerProposalSignature } from '../lib/balancer-proposal-signature.js';

const SNAPSHOT_ID_MAX = 160;
const LABEL_MAX = 160;

/**
 * The signature is verified against `req.body`, which Fastify has already
 * replaced with this schema's *output*. Every schema below is therefore
 * strictly non-transforming — no `.trim()`, no `.default()`, `.passthrough()`
 * at every level — so the parsed body is byte-equivalent to what the exporter
 * signed. A transform anywhere here would silently 401 every delivery that
 * relies on it, and would also drop payload the exporter is free to add.
 * Normalisation (absent team → `null`) happens at storage time instead.
 */
const proposalEntry = z
  .object({
    subject_type: z.enum(BALANCER_SUBJECT_TYPES),
    subject_id: z.string().min(1).max(SNAPSHOT_ID_MAX),
    label: z.string().min(1).max(LABEL_MAX),
    current_team: z.number().int().nullable().optional(),
    target_team: z.number().int().nullable().optional(),
    state: z.enum(BALANCER_PROPOSAL_STATES),
  })
  .passthrough();

const snapshotBody = z
  .object({
    source_snapshot_id: z.string().min(1).max(SNAPSHOT_ID_MAX),
    server_id: z.string().uuid(),
    match_id: z.string().uuid().nullable().optional(),
    layer: z.string().min(1).max(LABEL_MAX).nullable().optional(),
    gamemode: z.string().min(1).max(LABEL_MAX).nullable().optional(),
    mode: z.enum(BALANCER_PROPOSAL_MODES),
    schema_version: z.number().int().min(1).max(1000).optional(),
    generated_at: z.string().datetime({ offset: true }),
    signals: z.record(z.unknown()).optional(),
    proposal: z.array(proposalEntry).max(200).optional(),
  })
  .passthrough();

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * GAME-2 (#81) inbound webhook: the SquadJS exporter pushes one signed dry-run
 * balance snapshot per call.
 *
 * A push webhook was chosen over a Redis-stream consumer or outbound polling
 * because it is the only transport the panel already operates cross-repo (the
 * VIP lifecycle endpoint) and it assumes nothing about the exporter sharing the
 * panel's Redis or credentials. Disabled outright without
 * `BALANCER_WEBHOOK_SECRET`, so an unconfigured deployment cannot be written to.
 *
 * Delivery is idempotent on `source_snapshot_id`: a redelivered snapshot
 * refreshes the stored row instead of duplicating it. A genuinely new snapshot
 * additionally marks the previous still-`open` snapshot for the same
 * `(server_id, mode)` pair as `superseded`, so the review UI never shows two
 * competing "current" proposals.
 *
 * `config: { audit: false }` matches the VIP lifecycle precedent — this is a
 * machine-to-machine ingestion endpoint carrying no operator action, and its
 * URL is listed in `test/audit-coverage.test.ts`'s allowlist. Nothing ingested
 * here is ever executed: the balancer writes database rows only.
 */
const integrationsBalancerRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/integrations/balancer/proposals',
    {
      schema: { body: snapshotBody },
      config: { audit: false },
    },
    async (req, reply) => {
      const secret = app.config.BALANCER_WEBHOOK_SECRET;
      if (!secret) {
        reply.code(503);
        return { error: 'balancer_webhook_disabled' };
      }

      const timestamp = headerValue(req.headers['x-balancer-timestamp']);
      const signature = headerValue(req.headers['x-balancer-signature']);
      if (!verifyBalancerProposalSignature(secret, timestamp, signature, req.body)) {
        reply.code(401);
        return { error: 'invalid_signature' };
      }

      const body = req.body;
      const [server] = await app.db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.id, body.server_id))
        .limit(1);
      if (!server) {
        reply.code(404);
        return { error: 'server_not_found' };
      }

      const now = new Date();
      const proposal: BalancerProposalEntry[] = (body.proposal ?? []).map((entry) => ({
        ...entry,
        subject_type: entry.subject_type,
        subject_id: entry.subject_id,
        label: entry.label,
        current_team: entry.current_team ?? null,
        target_team: entry.target_team ?? null,
        state: entry.state,
      }));
      const values = {
        sourceSnapshotId: body.source_snapshot_id,
        serverId: body.server_id,
        matchId: body.match_id ?? null,
        layer: body.layer ?? null,
        gamemode: body.gamemode ?? null,
        mode: body.mode,
        schemaVersion: body.schema_version ?? BALANCER_SCHEMA_VERSION,
        generatedAt: new Date(body.generated_at),
        signals: body.signals ?? {},
        proposal,
        receivedAt: now,
      };

      const result = await app.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(balancerProposals)
          .values(values)
          .onConflictDoNothing({ target: balancerProposals.sourceSnapshotId })
          .returning({ id: balancerProposals.id });

        const created = inserted[0];
        if (!created) {
          const updated = await tx
            .update(balancerProposals)
            .set(values)
            .where(eq(balancerProposals.sourceSnapshotId, body.source_snapshot_id))
            .returning({ id: balancerProposals.id });
          return { duplicate: true as const, id: updated[0]?.id ?? null };
        }

        await tx
          .update(balancerProposals)
          .set({ status: 'superseded' })
          .where(
            and(
              eq(balancerProposals.serverId, body.server_id),
              eq(balancerProposals.mode, body.mode),
              eq(balancerProposals.status, 'open'),
              ne(balancerProposals.id, created.id),
            ),
          );
        return { duplicate: false as const, id: created.id };
      });

      reply.code(result.duplicate ? 200 : 202);
      return { ok: true, duplicate: result.duplicate, proposal_id: result.id };
    },
  );
};

export default integrationsBalancerRoutes;
