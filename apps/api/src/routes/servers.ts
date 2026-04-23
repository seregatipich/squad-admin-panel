import { randomBytes } from 'node:crypto';
import { organizations, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { serverCreateInput } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { encrypt, serialize } from '../lib/crypto.js';

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
      return { items: rows, total: rows.length };
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
      const settings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, req.params.id),
      });
      return { server: row, settings };
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
