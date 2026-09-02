import { createHash } from 'node:crypto';
import { findVipLifecycleOwner, type VipGrantExecutor, vipLifecycleRoleComment } from '@squad/db';
import {
  auditLog,
  players,
  roles,
  servers,
  vipLifecycleEvents,
  vipSubscriptions,
  vipTiers,
} from '@squad/db/schema';
import { and, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';
import { canonicalJson, verifyVipLifecycleSignature } from '../lib/vip-lifecycle-signature.js';

const vipLifecycleEventTypeSchema = z.enum([
  'vip.purchased',
  'vip.extended',
  'vip.expired',
  'vip.refunded',
]);

const vipLifecycleBody = z
  .object({
    event_id: z.string().trim().min(1).max(160),
    event_type: vipLifecycleEventTypeSchema,
    player_id: z.string().uuid().optional(),
    steam_id64: z
      .string()
      .regex(/^\d{17}$/)
      .optional(),
    role_id: z.string().uuid(),
    tier: z.string().trim().min(1).max(64).nullable().optional(),
    purchase_id: z.string().trim().min(1).max(160).nullable().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    revision: z.number().int().positive().optional(),
    discord_id: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.player_id && !body.steam_id64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['player_id'],
        message: 'player_id or steam_id64 is required',
      });
    }
  });

const vipPreflightBody = z.object({
  steam_id64: z.string().regex(/^\d{17}$/),
  role_id: z.string().uuid(),
  tier: z.string().trim().min(1).max(64),
});

type VipLifecycleBody = z.infer<typeof vipLifecycleBody>;
type VipLifecycleAction = 'assigned' | 'revoked' | 'ignored' | 'superseded';

function isAssignEvent(eventType: VipLifecycleBody['event_type']): boolean {
  return eventType === 'vip.purchased' || eventType === 'vip.extended';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type VipTargetError =
  | 'player_not_found'
  | 'player_eos_missing'
  | 'role_not_vip'
  | 'role_conflict'
  | 'manual_role_conflict'
  | 'vip_subscription_conflict';

type VipTargetInput = {
  player_id?: string;
  steam_id64?: string;
  role_id: string;
  purchase_id?: string | null;
};

type VipTargetPlayer = {
  id: string;
  steamId64: bigint | null;
  eosId: string | null;
  roleId: string | null;
  roleExpiresAt: Date | null;
  roleComment: string | null;
  roleLifecycleEventId: string | null;
};

type VipTargetResult =
  | { error: VipTargetError }
  | {
      player: VipTargetPlayer;
      rolePanelAccess: boolean;
      projectionOwner: 'bss-store' | null;
      expiresAt: Date | null;
    };

async function selectVipLifecyclePlayer(
  tx: VipGrantExecutor,
  input: Pick<VipTargetInput, 'player_id' | 'steam_id64'>,
  lockPlayer: boolean,
): Promise<VipTargetPlayer | null> {
  const condition = input.player_id
    ? eq(players.id, input.player_id)
    : input.steam_id64
      ? eq(players.steamId64, BigInt(input.steam_id64))
      : null;
  if (!condition) return null;

  const query = tx
    .select({
      id: players.id,
      steamId64: players.steamId64,
      eosId: players.eosId,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
      roleComment: players.roleComment,
      roleLifecycleEventId: players.roleLifecycleEventId,
    })
    .from(players)
    .where(condition)
    .limit(1);
  const [player] = lockPlayer ? await query.for('update') : await query;
  return player ?? null;
}

export async function checkVipLifecycleTarget(
  tx: VipGrantExecutor,
  input: VipTargetInput,
  options: { lockPlayer: boolean; player?: VipTargetPlayer },
): Promise<VipTargetResult> {
  const player = options.player ?? (await selectVipLifecyclePlayer(tx, input, options.lockPlayer));
  if (!player) return { error: 'player_not_found' };
  if (!player.eosId?.trim()) return { error: 'player_eos_missing' };

  const tiers = await tx
    .select({
      rolePanelAccess: roles.panelAccess,
      roleIsSystem: roles.isSystemRole,
    })
    .from(vipTiers)
    .innerJoin(roles, eq(roles.id, vipTiers.roleId))
    .where(and(eq(vipTiers.roleId, input.role_id), eq(vipTiers.isActive, true)))
    .limit(2);
  const tier = tiers[0];
  if (!tier || tiers.length !== 1 || tier.roleIsSystem || tier.rolePanelAccess) {
    return { error: 'role_not_vip' };
  }

  const [subscription] = await tx
    .select({ id: vipSubscriptions.id })
    .from(vipSubscriptions)
    .where(and(eq(vipSubscriptions.playerId, player.id), eq(vipSubscriptions.status, 'active')))
    .limit(1);
  if (subscription) return { error: 'vip_subscription_conflict' };

  const projectionOwner = await findVipLifecycleOwner(
    tx,
    player,
    Object.hasOwn(input, 'purchase_id') ? input.purchase_id : undefined,
  );
  if (player.roleId && player.roleId !== input.role_id) return { error: 'role_conflict' };
  if (player.roleId && !projectionOwner) return { error: 'manual_role_conflict' };

  return {
    player,
    rolePanelAccess: tier.rolePanelAccess,
    projectionOwner: projectionOwner ? 'bss-store' : null,
    expiresAt: projectionOwner?.expiresAt ?? null,
  };
}

type VipLifecycleError =
  | VipTargetError
  | 'event_body_conflict'
  | 'expires_at_required'
  | 'no_target_servers'
  | 'revision_conflict'
  | 'revision_required'
  | 'role_expiry_must_be_future';

function targetErrorStatus(error: VipLifecycleError): number {
  if (error === 'player_not_found') return 404;
  if (error === 'role_not_vip') return 403;
  if (error === 'expires_at_required' || error === 'role_expiry_must_be_future') return 400;
  return 409;
}

function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const candidate = current as { code?: string; constraint_name?: string; cause?: unknown };
    if (candidate.code === '23505') return candidate.constraint_name ?? '';
    current = candidate.cause;
  }
  return null;
}

const integrationsVipRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/integrations/vip/preflight',
    {
      schema: { body: vipPreflightBody },
      config: { audit: false, public: true },
    },
    async (req, reply) => {
      const secret = app.config.VIP_LIFECYCLE_WEBHOOK_SECRET;
      if (!secret) {
        reply.code(503);
        return { error: 'vip_lifecycle_webhook_disabled' };
      }
      const timestamp = headerValue(req.headers['x-vip-timestamp']);
      const signature = headerValue(req.headers['x-vip-signature']);
      if (!verifyVipLifecycleSignature(secret, timestamp, signature, req.body)) {
        reply.code(401);
        return { error: 'invalid_signature' };
      }

      const result = await app.db.transaction(async (tx) => {
        const target = await checkVipLifecycleTarget(tx, req.body, { lockPlayer: false });
        if ('error' in target) return target;
        const serverIds = await tx
          .select({ id: servers.id })
          .from(servers)
          .where(isNull(servers.deletedAt));
        if (serverIds.length === 0) return { error: 'no_target_servers' as const };
        return { target, serversTotal: serverIds.length };
      });
      if ('error' in result && result.error) {
        reply.code(targetErrorStatus(result.error));
        return { error: result.error, error_code: result.error };
      }
      return {
        ok: true,
        servers_total: result.serversTotal,
        projection_owner: result.target.projectionOwner,
        expires_at: result.target.expiresAt?.toISOString() ?? null,
      };
    },
  );

  fast.post(
    '/api/v1/integrations/vip/lifecycle',
    {
      schema: { body: vipLifecycleBody },
      config: { audit: false, public: true },
    },
    async (req, reply) => {
      const secret = app.config.VIP_LIFECYCLE_WEBHOOK_SECRET;
      if (!secret) {
        reply.code(503);
        return { error: 'vip_lifecycle_webhook_disabled' };
      }

      const timestamp = headerValue(req.headers['x-vip-timestamp']);
      const signature = headerValue(req.headers['x-vip-signature']);
      if (!verifyVipLifecycleSignature(secret, timestamp, signature, req.body)) {
        reply.code(401);
        return { error: 'invalid_signature' };
      }

      const body = req.body;
      if (app.config.VIP_LIFECYCLE_REQUIRE_REVISION && body.revision === undefined) {
        reply.code(400);
        return { error: 'revision_required' };
      }
      const now = new Date();
      const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
      const assignEvent = isAssignEvent(body.event_type);
      const shouldAssign =
        assignEvent ||
        (body.event_type === 'vip.refunded' && expiresAt !== null && expiresAt > now);

      const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
      const result = await app.db
        .transaction(async (tx) => {
          const player = await selectVipLifecyclePlayer(tx, body, true);
          if (!player) return { error: 'player_not_found' as const };

          const [existingEvent] = await tx
            .select({
              payload: vipLifecycleEvents.payload,
              requestHash: vipLifecycleEvents.requestHash,
            })
            .from(vipLifecycleEvents)
            .where(eq(vipLifecycleEvents.eventId, body.event_id))
            .limit(1);
          if (existingEvent) {
            const existingHash =
              existingEvent.requestHash ??
              createHash('sha256').update(canonicalJson(existingEvent.payload)).digest('hex');
            return existingHash === requestHash
              ? { duplicate: true as const }
              : { error: 'event_body_conflict' as const };
          }

          if (assignEvent) {
            if (!expiresAt) return { error: 'expires_at_required' as const };
            if (expiresAt <= now) return { error: 'role_expiry_must_be_future' as const };
          }

          const [currentRevision] = await tx
            .select({
              eventId: vipLifecycleEvents.eventId,
              revision: vipLifecycleEvents.revision,
            })
            .from(vipLifecycleEvents)
            .where(
              and(
                eq(vipLifecycleEvents.playerId, player.id),
                isNotNull(vipLifecycleEvents.revision),
              ),
            )
            .orderBy(desc(vipLifecycleEvents.revision))
            .limit(1);
          if (currentRevision) {
            if (body.revision === undefined) return { error: 'revision_required' as const };
            if (body.revision === currentRevision.revision) {
              return { error: 'revision_conflict' as const };
            }
            if (body.revision < (currentRevision.revision ?? 0)) {
              await tx.insert(vipLifecycleEvents).values({
                eventId: body.event_id,
                eventType: body.event_type,
                playerId: player.id,
                roleId: body.role_id,
                tier: body.tier ?? null,
                purchaseId: body.purchase_id ?? null,
                revision: body.revision,
                requestHash,
                supersededByEventId: currentRevision.eventId,
                action: 'superseded',
                payload: body,
                receivedAt: now,
              });
              return {
                duplicate: false as const,
                action: 'superseded' as const,
                enqueued: 0,
                rolePanelAccess: false,
                playerId: player.id,
              };
            }
          }

          const targetInput: VipTargetInput = {
            player_id: body.player_id,
            steam_id64: body.steam_id64,
            role_id: body.role_id,
            ...(shouldAssign ? {} : { purchase_id: body.purchase_id ?? null }),
          };
          const target = await checkVipLifecycleTarget(tx, targetInput, {
            lockPlayer: false,
            player,
          });
          if ('error' in target) return target;

          const serverRows = await tx
            .select({ id: servers.id })
            .from(servers)
            .where(isNull(servers.deletedAt));
          if (serverRows.length === 0) return { error: 'no_target_servers' as const };
          const serverIds = serverRows.map((server) => server.id);

          const action: VipLifecycleAction = shouldAssign
            ? 'assigned'
            : player.roleId === body.role_id
              ? 'revoked'
              : 'ignored';

          await tx.insert(vipLifecycleEvents).values({
            eventId: body.event_id,
            eventType: body.event_type,
            playerId: player.id,
            roleId: body.role_id,
            tier: body.tier ?? null,
            purchaseId: body.purchase_id ?? null,
            revision: body.revision ?? null,
            requestHash,
            action,
            payload: body,
            receivedAt: now,
            appliedAt: now,
          });

          if (body.revision !== undefined) {
            await tx
              .update(vipLifecycleEvents)
              .set({ supersededByEventId: body.event_id })
              .where(
                and(
                  eq(vipLifecycleEvents.playerId, player.id),
                  isNotNull(vipLifecycleEvents.revision),
                  isNull(vipLifecycleEvents.supersededByEventId),
                  ne(vipLifecycleEvents.eventId, body.event_id),
                ),
              );
          }

          if (action === 'assigned') {
            await tx
              .update(players)
              .set({
                roleId: body.role_id,
                roleExpiresAt: expiresAt,
                roleComment: vipLifecycleRoleComment(body.tier ?? null, body.purchase_id ?? null),
                roleLifecycleEventId: body.event_id,
                updatedAt: now,
              })
              .where(eq(players.id, player.id));
          } else if (action === 'revoked') {
            await tx
              .update(players)
              .set({
                roleId: null,
                roleExpiresAt: null,
                roleComment: null,
                roleLifecycleEventId: null,
                updatedAt: now,
              })
              .where(eq(players.id, player.id));
          }

          const syncResult = await publishAdminsCfgSyncForAllServers(
            tx,
            {
              reason: `vip.lifecycle.${action}`,
              actor_player_id: null,
              enqueued_at: now.toISOString(),
              request_id: req.id,
            },
            serverIds,
            body.event_id,
          );

          await tx.insert(auditLog).values({
            actorKind: 'system',
            actorSystemLabel: 'vip-user-service',
            actorIp: req.ip ?? null,
            actionType: 'vip.lifecycle.apply',
            targetType: 'player',
            targetId: player.id,
            beforeSnapshot: {
              role_id: player.roleId,
            },
            afterSnapshot:
              action === 'assigned'
                ? {
                    role_id: body.role_id,
                    role_expires_at: expiresAt?.toISOString() ?? null,
                    role_comment: vipLifecycleRoleComment(
                      body.tier ?? null,
                      body.purchase_id ?? null,
                    ),
                  }
                : action === 'revoked'
                  ? { role_id: null, role_expires_at: null, role_comment: null }
                  : { role_id: player.roleId },
            context: {
              event_id: body.event_id,
              event_type: body.event_type,
              purchase_id: body.purchase_id ?? null,
              tier: body.tier ?? null,
              request_id: req.id,
              action,
            },
            statusCode: 202,
            rowHash: Buffer.from([]),
          });

          return {
            duplicate: false as const,
            action,
            enqueued: syncResult.enqueued,
            rolePanelAccess: target.rolePanelAccess,
            playerId: player.id,
          };
        })
        .catch((error): { error: 'event_body_conflict' | 'revision_conflict' } => {
          const constraint = uniqueViolationConstraint(error);
          if (constraint === 'vip_lifecycle_events_pkey') {
            return { error: 'event_body_conflict' };
          }
          if (constraint === 'vip_lifecycle_events_player_revision_key') {
            return { error: 'revision_conflict' };
          }
          throw error;
        });

      if ('error' in result && result.error) {
        reply.code(targetErrorStatus(result.error));
        return { error: result.error, error_code: result.error };
      }

      if (result.duplicate) {
        reply.code(200);
        return { ok: true, duplicate: true };
      }

      if (result.action !== 'superseded') invalidatePermissionCache(result.playerId);
      if (
        result.action === 'revoked' ||
        (result.action === 'assigned' && !result.rolePanelAccess)
      ) {
        await revokeAllForPlayer(app.db, app.redis, result.playerId, app.liveBus);
      }

      reply.code(202);
      return {
        ok: true,
        duplicate: false,
        action: result.action,
        enqueued: result.enqueued,
      };
    },
  );
};

export default integrationsVipRoutes;
