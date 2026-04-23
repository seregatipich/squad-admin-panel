import { randomBytes } from 'node:crypto';
import { organizations, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { serverCreateInput } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { decryptString, deserialize, encrypt, serialize } from '../lib/crypto.js';
import { rconSendOnce } from '../lib/rcon-send.js';

const serverIdParams = z.object({ id: z.string().uuid() });

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
          tags: servers.tags,
          created_at: servers.createdAt,
          updated_at: servers.updatedAt,
        })
        .from(servers)
        .orderBy(servers.displayName);
      // Enrich every row with the live RCON state / player count that
      // worker-rcon publishes to rcon:status:{uuid}. Falling back to
      // nulls so the UI can render the row even when no poll has
      // happened yet.
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
        });
        await tx.insert(serverSettings).values({
          serverId: id,
          installPath: `/opt/squad-servers/${id}`,
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
        await tx.insert(serverCredentials).values({
          serverId: id,
          rconHost: '127.0.0.1',
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
      // state='not_polled' is distinct from 'disconnected': the former
      // means worker-rcon isn't watching this server (because DB says it
      // isn't running); the latter means it IS watching but the socket
      // failed. UI renders not_polled as '—' so it doesn't read as an
      // error.
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
      await app.bridge.systemctlAction({
        unit: `squad-server-${s.id}.service`,
        action: 'start',
      });
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

      // Graceful shutdown (TZ §17.7): broadcast → end match → systemctl stop.
      // Any RCON failure is logged and we still fall through to systemctl stop
      // so a broken RCON can never wedge a server admin trying to halt a host.
      if (settings && creds) {
        try {
          const password = decryptString(
            app.encryptionKey,
            deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
          );
          const target = {
            host: creds.rconHost ?? '127.0.0.1',
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

      await app.bridge.systemctlAction({
        unit: `squad-server-${s.id}.service`,
        action: 'stop',
      });
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
      await app.bridge.systemctlAction({
        unit: `squad-server-${s.id}.service`,
        action: 'restart',
      });
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
      // Pull the last N entries from the per-server Redis stream that
      // worker-rcon and worker-log-ingest publish to. XREVRANGE gives
      // newest-first for a direct UI render.
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
      await app.db.delete(servers).where(eq(servers.id, req.params.id));
      return { ok: true };
    },
  );
};

export default serverRoutes;
