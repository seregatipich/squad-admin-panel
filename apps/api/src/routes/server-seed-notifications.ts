import {
  events,
  notifySeedSubscribers,
  seedSubscriptions,
  serverCredentials,
  serverSettings,
  servers,
} from '@squad/db';
import { type EventEnvelope, STREAM_NAME, seedCallSentPayload } from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { isExternalRuntime } from '../lib/server-runtime.js';

export const SEED_CALL_COOLDOWN_SECONDS = 2 * 60 * 60;
const SEED_CHANNELS = ['email', 'webpush'] as const;

const serverIdParams = z.object({ id: z.string().uuid() });
const subscriptionBody = z.object({
  channel: z.enum(SEED_CHANNELS),
  enabled: z.boolean(),
});

function canCallSeeders(req: FastifyRequest): boolean {
  return (
    req.user?.permissions.squadPermissions.has('chat') === true ||
    req.user?.permissions.squadPermissions.has('manageserver') === true
  );
}

function cooldownKey(serverId: string): string {
  return `seed:call:cooldown:${serverId}`;
}

async function retryAfter(
  redis: Pick<FastifyInstance['redis'], 'ttl'>,
  serverId: string,
): Promise<number> {
  const ttl = await redis.ttl(cooldownKey(serverId));
  return Math.max(1, ttl > 0 ? ttl : SEED_CALL_COOLDOWN_SECONDS);
}

async function publishSeedCallEvent(
  app: Parameters<FastifyPluginAsync>[0],
  serverId: string,
  actorPlayerId: string,
  payload: Record<string, unknown>,
): Promise<EventEnvelope> {
  const parsedPayload = seedCallSentPayload.parse(payload);
  const envelope: EventEnvelope = {
    event_id: uuidv7(),
    version: 1,
    type: 'seed.call_sent',
    server_id: serverId,
    ts: new Date().toISOString(),
    actor: { kind: 'user', id: actorPlayerId },
    correlation_id: null,
    payload: parsedPayload,
  };
  await app.db.insert(events).values({
    eventId: envelope.event_id,
    serverId,
    occurredAt: new Date(envelope.ts),
    kind: envelope.type,
    version: envelope.version,
    actorKind: envelope.actor?.kind ?? null,
    actorId: envelope.actor?.id ?? null,
    correlationId: null,
    payload: envelope.payload,
  });
  await app.redis.xadd(
    STREAM_NAME.eventsServer(serverId),
    'MAXLEN',
    '~',
    '10000',
    '*',
    'envelope',
    JSON.stringify(envelope),
  );
  return envelope;
}

/** How long the panel host's address is reused before `host_info` is asked again. */
const HOST_INFO_TTL_MS = 60_000;

const serverSeedNotificationRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  let panelHostCache: { address: string; at: number } | null = null;

  /**
   * Address players use to reach a panel-hosted server: the host's name, else
   * its first IP. Cached for `HOST_INFO_TTL_MS`; null when the bridge cannot
   * answer.
   */
  async function panelHostAddress(): Promise<string | null> {
    if (panelHostCache && Date.now() - panelHostCache.at < HOST_INFO_TTL_MS) {
      return panelHostCache.address;
    }
    let host: Awaited<ReturnType<FastifyInstance['bridge']['hostInfo']>>;
    try {
      host = await app.bridge.hostInfo();
    } catch {
      return null;
    }
    const address = host.hostname || host.ip_addresses[0];
    if (!address) return null;
    panelHostCache = { address, at: Date.now() };
    return address;
  }

  /**
   * Loads the server, its settings and the address in its join link. An
   * external server runs elsewhere, so its address is its RCON host rather
   * than the panel's; `host` is null when no address is known.
   */
  async function loadServerContext(serverId: string) {
    const server = await app.db.query.servers.findFirst({
      where: and(eq(servers.id, serverId), isNull(servers.deletedAt)),
    });
    if (!server) return null;
    const settings = await app.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, serverId),
    });
    if (!settings) return { server, settings: null, host: null };

    let address: string | null;
    if (isExternalRuntime(server.runtime)) {
      const credentials = await app.db.query.serverCredentials.findFirst({
        where: eq(serverCredentials.serverId, serverId),
      });
      address = credentials?.rconHost ?? null;
    } else {
      address = await panelHostAddress();
    }
    if (!address) return { server, settings, host: null };
    return {
      server,
      settings,
      host: { address, joinLink: `steam://connect/${address}:${settings.gamePort}` },
    };
  }

  fast.get(
    '/api/v1/seed-subscriptions',
    { config: { permissions: ['server:view'], audit: false } },
    async (req) => {
      const rows = await app.db
        .select({
          server_id: seedSubscriptions.serverId,
          server_name: servers.displayName,
          channel: seedSubscriptions.channel,
        })
        .from(seedSubscriptions)
        .innerJoin(servers, eq(servers.id, seedSubscriptions.serverId))
        .where(
          and(eq(seedSubscriptions.playerId, req.user?.playerId ?? ''), isNull(servers.deletedAt)),
        );
      return { subscriptions: rows };
    },
  );

  fast.put(
    '/api/v1/servers/:id/seed-subscription',
    {
      schema: { params: serverIdParams, body: subscriptionBody },
      config: {
        permissions: ['server:view'],
        audit: { action: 'seed.subscription.update', resource: 'server' },
      },
    },
    async (req, reply) => {
      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const values = {
        playerId: req.user?.playerId ?? '',
        serverId: req.params.id,
        channel: req.body.channel,
      };
      if (req.body.enabled) {
        await app.db.insert(seedSubscriptions).values(values).onConflictDoNothing();
      } else {
        await app.db
          .delete(seedSubscriptions)
          .where(
            and(
              eq(seedSubscriptions.playerId, values.playerId),
              eq(seedSubscriptions.serverId, values.serverId),
              eq(seedSubscriptions.channel, values.channel),
            ),
          );
      }
      req.auditSnapshots = { after: { channel: req.body.channel, enabled: req.body.enabled } };
      return { server_id: req.params.id, channel: req.body.channel, enabled: req.body.enabled };
    },
  );

  fast.get(
    '/api/v1/servers/:id/seed-call',
    { schema: { params: serverIdParams }, config: { permissions: ['server:view'], audit: false } },
    async (req, reply) => {
      const context = await loadServerContext(req.params.id);
      if (!context) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const remaining = await app.redis.ttl(cooldownKey(req.params.id));
      return {
        available: remaining <= 0,
        retry_after: remaining > 0 ? remaining : 0,
        join_link: context.host?.joinLink ?? null,
      };
    },
  );

  fast.post(
    '/api/v1/servers/:id/seed-call',
    {
      schema: { params: serverIdParams },
      config: { audit: { action: 'seed.call_sent', resource: 'server' } },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!canCallSeeders(req)) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permissions: ['chat', 'manageserver'] };
      }

      const context = await loadServerContext(req.params.id);
      if (!context) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (!context.settings) {
        reply.code(400);
        return { error: 'server_not_installed' };
      }
      if (!context.host) {
        reply.code(503);
        return { error: 'host_unavailable' };
      }

      const claimed = await app.redis.set(
        cooldownKey(req.params.id),
        new Date().toISOString(),
        'EX',
        SEED_CALL_COOLDOWN_SECONDS,
        'NX',
      );
      if (!claimed) {
        const seconds = await retryAfter(app.redis, req.params.id);
        reply.header('Retry-After', String(seconds)).code(429);
        return { error: 'seed_call_rate_limited', retry_after: seconds };
      }

      const payload = {
        server_name: context.server.displayName,
        join_link: context.host.joinLink,
        seed_layer: null,
        scheduled_for: null,
        source: 'manual' as const,
        message: 'Нужен сид',
      };
      let envelope: EventEnvelope;
      let notified: number;
      try {
        envelope = await publishSeedCallEvent(app, req.params.id, req.user.playerId, payload);
        notified = await notifySeedSubscribers(app.db, app.redis, {
          serverId: req.params.id,
          eventKind: 'seed.call_sent',
          payload,
        });
      } catch (err) {
        // Nothing reached the seeders: give the call back instead of locking
        // every admin out for the full cooldown.
        await app.redis.del(cooldownKey(req.params.id)).catch(() => undefined);
        throw err;
      }
      req.auditSnapshots = {
        after: { ...payload, notified },
        context: { event_id: envelope.event_id },
      };
      return {
        ok: true,
        event_id: envelope.event_id,
        join_link: context.host.joinLink,
        retry_after: SEED_CALL_COOLDOWN_SECONDS,
        notified,
      };
    },
  );
};

export default serverSeedNotificationRoutes;
