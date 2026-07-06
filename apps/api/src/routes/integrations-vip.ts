import { auditLog, players, roles, vipLifecycleEvents } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';
import { verifyVipLifecycleSignature } from '../lib/vip-lifecycle-signature.js';

const vipLifecycleEventTypeSchema = z.enum([
  'vip.purchased',
  'vip.extended',
  'vip.expired',
  'vip.refunded',
]);

const vipLifecycleBody = z.object({
  event_id: z.string().trim().min(1).max(160),
  event_type: vipLifecycleEventTypeSchema,
  player_id: z.string().uuid(),
  role_id: z.string().uuid(),
  tier: z.string().trim().min(1).max(64).nullable().optional(),
  purchase_id: z.string().trim().min(1).max(160).nullable().optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

type VipLifecycleBody = z.infer<typeof vipLifecycleBody>;
type VipLifecycleAction = 'assigned' | 'revoked' | 'ignored';

function isAssignEvent(eventType: VipLifecycleBody['event_type']): boolean {
  return eventType === 'vip.purchased' || eventType === 'vip.extended';
}

function roleComment(body: VipLifecycleBody): string {
  const tier = body.tier ?? 'vip';
  const purchase = body.purchase_id ? ` purchase ${body.purchase_id}` : '';
  return `VIP ${tier}${purchase}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const integrationsVipRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/integrations/vip/lifecycle',
    {
      schema: { body: vipLifecycleBody },
      config: { audit: false },
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
      const shouldAssign = isAssignEvent(body.event_type);
      const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
      if (shouldAssign && !expiresAt) {
        reply.code(400);
        return { error: 'expires_at_required' };
      }
      if (shouldAssign && expiresAt && expiresAt <= new Date()) {
        reply.code(400);
        return { error: 'role_expiry_must_be_future' };
      }

      const now = new Date();
      const result = await app.db.transaction(async (tx) => {
        const [player] = await tx
          .select({ roleId: players.roleId })
          .from(players)
          .where(eq(players.id, body.player_id))
          .limit(1);
        if (!player) {
          return { error: 'player_not_found' as const };
        }

        const [role] = await tx
          .select({
            id: roles.id,
            name: roles.name,
            isSystemRole: roles.isSystemRole,
            panelAccess: roles.panelAccess,
          })
          .from(roles)
          .where(eq(roles.id, body.role_id))
          .limit(1);
        if (!role) {
          return { error: 'role_not_found' as const };
        }
        if (role.isSystemRole && role.name === 'Owner') {
          return { error: 'owner_assignment_forbidden' as const };
        }

        const action: VipLifecycleAction = shouldAssign
          ? 'assigned'
          : player.roleId === body.role_id
            ? 'revoked'
            : 'ignored';

        const inserted = await tx
          .insert(vipLifecycleEvents)
          .values({
            eventId: body.event_id,
            eventType: body.event_type,
            playerId: body.player_id,
            roleId: body.role_id,
            tier: body.tier ?? null,
            purchaseId: body.purchase_id ?? null,
            action,
            payload: body,
            receivedAt: now,
            appliedAt: now,
          })
          .onConflictDoNothing()
          .returning({ eventId: vipLifecycleEvents.eventId });
        if (inserted.length === 0) {
          return { duplicate: true as const, action };
        }

        if (action === 'assigned') {
          await tx
            .update(players)
            .set({
              roleId: body.role_id,
              roleExpiresAt: expiresAt,
              roleComment: roleComment(body),
              updatedAt: now,
            })
            .where(eq(players.id, body.player_id));
        } else if (action === 'revoked') {
          await tx
            .update(players)
            .set({
              roleId: null,
              roleExpiresAt: null,
              roleComment: null,
              updatedAt: now,
            })
            .where(eq(players.id, body.player_id));
        }

        const syncResult =
          action === 'ignored'
            ? { enqueued: 0 }
            : await publishAdminsCfgSyncForAllServers(tx, app.redis, {
                reason: `vip.lifecycle.${action}`,
                actor_player_id: null,
                enqueued_at: now.toISOString(),
                request_id: req.id,
              });

        await tx.insert(auditLog).values({
          actorKind: 'system',
          actorSystemLabel: 'vip-user-service',
          actorIp: req.ip ?? null,
          actionType: 'vip.lifecycle.apply',
          targetType: 'player',
          targetId: body.player_id,
          beforeSnapshot: {
            role_id: player.roleId,
          },
          afterSnapshot:
            action === 'assigned'
              ? {
                  role_id: body.role_id,
                  role_expires_at: expiresAt?.toISOString() ?? null,
                  role_comment: roleComment(body),
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
          rolePanelAccess: role.panelAccess,
        };
      });

      if ('error' in result) {
        const status =
          result.error === 'player_not_found' || result.error === 'role_not_found' ? 404 : 403;
        reply.code(status);
        return { error: result.error };
      }

      if (result.duplicate) {
        reply.code(200);
        return { ok: true, duplicate: true };
      }

      invalidatePermissionCache(body.player_id);
      if (
        result.action === 'revoked' ||
        (result.action === 'assigned' && !result.rolePanelAccess)
      ) {
        await revokeAllForPlayer(app.db, app.redis, body.player_id);
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
