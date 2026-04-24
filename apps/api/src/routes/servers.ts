import { randomBytes } from 'node:crypto';
import { organizations, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import {
  DEPOT_VOLUME_NAME,
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_IMAGE,
} from '@squad/shared-config';
import { serverCreateInput } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { decryptString, deserialize, encrypt, serialize } from '../lib/crypto.js';
import { resolveRconHost } from '../lib/rcon-host.js';
import { rconSendOnce } from '../lib/rcon-send.js';

const serverIdParams = z.object({ id: z.string().uuid() });

function containerName(id: string) {
  return `squad-${id}`;
}

const serverRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers',
    {
      config: { permissions: ['server:view'], audit: false },
    },
    async () => {
      const rows = await app.db
        .select({
          id: servers.id,
          display_name: servers.displayName,
          slug: servers.slug,
          description: servers.description,
          status: servers.status,
          runtime: servers.runtime,
          tags: servers.tags,
          created_at: servers.createdAt,
          updated_at: servers.updatedAt,
        })
        .from(servers)
        .orderBy(servers.displayName);
      const items = await Promise.all(
        rows.map(async (r) => {
          const raw = await app.redis.get(`rcon:status:${r.id}`);
          let rconState: string | null = null;
          let playerCount: number | null = null;
          let lastPollAt: string | null = null;
          if (raw) {
            try {
              const s = JSON.parse(raw) as {
                state?: string;
                player_count?: number;
                last_poll_at?: string;
              };
              rconState = s.state ?? null;
              playerCount = typeof s.player_count === 'number' ? s.player_count : null;
              lastPollAt = s.last_poll_at ?? null;
            } catch {
              // ignore
            }
          }
          return {
            ...r,
            rcon_state: rconState,
            player_count: playerCount,
            last_poll_at: lastPollAt,
          };
        }),
      );
      return { items, total: items.length };
    },
  );

  fast.post(
    '/api/v1/servers',
    {
      config: {
        permissions: ['server:create'],
        audit: { action: 'server.create', resource: 'server' },
      },
      schema: { body: serverCreateInput },
    },
    async (req, reply) => {
      const orgs = await app.db.select().from(organizations).limit(1);
      const org = orgs[0];
      if (!org) {
        reply.code(400);
        return { error: 'no_organization' };
      }
      const id = uuidv7();
      const body = req.body;
      await app.db.transaction(async (tx) => {
        await tx.insert(servers).values({
          id,
          orgId: org.id,
          displayName: body.display_name,
          slug: body.slug,
          description: body.description ?? null,
          status: 'pending',
          runtime: 'container',
        });
        await tx.insert(serverSettings).values({
          serverId: id,
          installPath: `${PANEL_CONFIGS_ROOT}/${id}`,
          gamePort: body.game_port,
          queryPort: body.query_port,
          beaconPort: body.beacon_port,
          rconPort: body.rcon_port,
          maxPlayers: body.max_players ?? 100,
          tickrate: body.tickrate ?? 50,
          multihome: body.multihome ?? '0.0.0.0',
          extraArgs: body.extra_args ?? '',
          launchArgsOverride: body.launch_args_override ?? null,
          cpuAffinity: body.cpu_affinity ?? null,
          cpuWeight: body.cpu_weight ?? null,
          niceness: body.niceness ?? null,
          memoryHighMb: body.memory_high_mb ?? null,
          memoryMaxMb: body.memory_max_mb ?? null,
          ioWeight: body.io_weight ?? null,
        });
        const rconPassword = randomBytes(24).toString('base64url');
        const blob = encrypt(app.encryptionKey, rconPassword);
        // Leave rconHost unset so each downstream caller (api vs worker-rcon)
        // resolves it against its own RCON_HOST_DEFAULT env var at connect
        // time — see apps/workers/rcon/src/index.ts reconcile() and
        // server-configs.ts reloadServerConfig().
        await tx.insert(serverCredentials).values({
          serverId: id,
          rconPort: body.rcon_port,
          rconPasswordEncrypted: serialize(blob),
        });
      });
      reply.code(201);
      return { id, status: 'pending' };
    },
  );

  fast.get(
    '/api/v1/servers/:id',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: eq(servers.id, req.params.id),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const settingsRow = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, req.params.id),
      });
      const rconRaw = await app.redis.get(`rcon:status:${row.id}`);
      let rcon_status: unknown = { state: 'not_polled' };
      if (rconRaw) {
        try {
          rcon_status = JSON.parse(rconRaw);
        } catch {
          rcon_status = { state: 'not_polled' };
        }
      }
      return {
        server: {
          id: row.id,
          org_id: row.orgId,
          display_name: row.displayName,
          slug: row.slug,
          description: row.description,
          status: row.status,
          runtime: row.runtime,
          container_id: row.containerId,
          tags: row.tags,
          timezone: row.timezone,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        },
        settings: settingsRow
          ? {
              server_id: settingsRow.serverId,
              install_path: settingsRow.installPath,
              game_port: settingsRow.gamePort,
              query_port: settingsRow.queryPort,
              beacon_port: settingsRow.beaconPort,
              rcon_port: settingsRow.rconPort,
              max_players: settingsRow.maxPlayers,
              tickrate: settingsRow.tickrate,
              multihome: settingsRow.multihome,
              extra_args: settingsRow.extraArgs,
            }
          : null,
        rcon_status,
      };
    },
  );

  fast.post(
    '/api/v1/servers/:id/start',
    {
      config: {
        permissions: ['server:start'],
        audit: { action: 'server.start', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const s = await app.db.query.servers.findFirst({ where: eq(servers.id, req.params.id) });
      if (!s) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const settings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, s.id),
      });
      if (!settings) {
        reply.code(400);
        return { error: 'server_not_installed' };
      }
      const name = containerName(s.id);
      const inspect = await app.bridge.containerInspect({ name }).catch(() => null);
      if (inspect?.running) {
        await app.db
          .update(servers)
          .set({ status: 'running', updatedAt: new Date() })
          .where(eq(servers.id, s.id));
        return { status: 'running', note: 'already running' };
      }
      if (inspect && inspect.state !== 'not_found') {
        await app.bridge.containerStart({ name });
      } else {
        await app.bridge.containerRun({
          server_id: s.id,
          image: SERVER_IMAGE,
          game_port: settings.gamePort,
          query_port: settings.queryPort,
          beacon_port: settings.beaconPort,
          rcon_port: settings.rconPort,
          max_players: settings.maxPlayers,
          tickrate: settings.tickrate,
          multihome: settings.multihome,
          configs_host: `${PANEL_CONFIGS_ROOT}/${s.id}/ServerConfig`,
          saved_host: `${PANEL_SAVED_ROOT}/${s.id}`,
          depot_volume: DEPOT_VOLUME_NAME,
        });
      }
      await app.db
        .update(servers)
        .set({ status: 'starting', updatedAt: new Date() })
        .where(eq(servers.id, s.id));
      return { status: 'starting' };
    },
  );

  fast.post(
    '/api/v1/servers/:id/stop',
    {
      config: {
        permissions: ['server:stop'],
        audit: { action: 'server.stop', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const s = await app.db.query.servers.findFirst({ where: eq(servers.id, req.params.id) });
      if (!s) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const settings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, s.id),
      });
      const creds = await app.db.query.serverCredentials.findFirst({
        where: eq(serverCredentials.serverId, s.id),
      });

      // Graceful shutdown (TZ §17.7): broadcast → end match → stop container.
      if (settings && creds) {
        try {
          const password = decryptString(
            app.encryptionKey,
            deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
          );
          const target = {
            host: resolveRconHost(creds.rconHost),
            port: creds.rconPort,
            password,
          };
          await rconSendOnce({
            ...target,
            command: 'AdminBroadcast Server is shutting down in 15 seconds',
            connectTimeoutMs: 2000,
            commandTimeoutMs: 3000,
          }).catch((err) => {
            req.log.warn({ err: (err as Error).message }, 'AdminBroadcast failed; continuing');
          });
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          await rconSendOnce({
            ...target,
            command: 'AdminEndMatch',
            connectTimeoutMs: 2000,
            commandTimeoutMs: 3000,
          }).catch((err) => {
            req.log.warn({ err: (err as Error).message }, 'AdminEndMatch failed; continuing');
          });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'graceful stop RCON phase skipped');
        }
      }

      await app.bridge.containerStop({ name: containerName(s.id), timeout_sec: 60 });
      await app.db
        .update(servers)
        .set({ status: 'stopping', updatedAt: new Date() })
        .where(eq(servers.id, s.id));
      return { status: 'stopping' };
    },
  );

  fast.post(
    '/api/v1/servers/:id/restart',
    {
      config: {
        permissions: ['server:restart'],
        audit: { action: 'server.restart', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const s = await app.db.query.servers.findFirst({ where: eq(servers.id, req.params.id) });
      if (!s) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const name = containerName(s.id);
      await app.bridge.containerStop({ name, timeout_sec: 60 }).catch(() => {});
      await app.bridge.containerStart({ name });
      await app.db
        .update(servers)
        .set({ status: 'starting', updatedAt: new Date() })
        .where(eq(servers.id, s.id));
      return { status: 'restarting' };
    },
  );

  fast.get(
    '/api/v1/servers/:id/events',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: {
        params: serverIdParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req) => {
      const stream = `events:server:${req.params.id}`;
      const raw = (await app.redis.xrevrange(stream, '+', '-', 'COUNT', req.query.limit)) as Array<
        [string, string[]]
      >;
      const items: Array<{
        stream_id: string;
        event_id: string;
        type: string;
        ts: string;
        payload: unknown;
      }> = [];
      for (const [streamId, kv] of raw) {
        const envIdx = kv.indexOf('envelope');
        if (envIdx < 0 || envIdx + 1 >= kv.length) continue;
        const rawEnv = kv[envIdx + 1];
        if (!rawEnv) continue;
        try {
          const env = JSON.parse(rawEnv) as {
            event_id: string;
            type: string;
            ts: string;
            payload: unknown;
          };
          items.push({
            stream_id: streamId,
            event_id: env.event_id,
            type: env.type,
            ts: env.ts,
            payload: env.payload,
          });
        } catch {
          // ignore bad envelopes
        }
      }
      return { items, total: items.length };
    },
  );

  fast.delete(
    '/api/v1/servers/:id',
    {
      config: {
        permissions: ['server:delete'],
        audit: { action: 'server.delete', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({ where: eq(servers.id, req.params.id) });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      await app.bridge.containerRm({ name: containerName(row.id) }).catch(() => {});
      await app.db.delete(servers).where(eq(servers.id, req.params.id));
      return { ok: true };
    },
  );
};

export default serverRoutes;
