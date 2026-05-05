import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { serverPatch, serverSettingsUpdate } from '@squad/shared-types';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { encrypt, serialize } from '../lib/crypto.js';

const idParam = z.object({ id: z.string().uuid() });

/** Statuses that allow port changes (server is not running). */
const PORT_CHANGEABLE_STATUSES = new Set(['stopped', 'ready', 'pending', 'failed']);

/** Fields that map to a port column for conflict-checking and UFW updates. */
const PORT_FIELDS = ['game_port', 'query_port', 'beacon_port', 'rcon_port'] as const;
type PortField = (typeof PORT_FIELDS)[number];

const serverSettingsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * PUT /api/v1/servers/:id/settings
   * Partially updates the server_settings row.
   * - Port changes only allowed when server is stopped/ready/pending/failed.
   * - Resource-limit fields (cpu_affinity, cpu_weight, niceness, memory_high_mb,
   *   memory_max_mb, io_weight) may be changed at any time.
   * - New ports must not conflict with other active servers' ports.
   * - Same-server ports (across all four port fields) must all be distinct.
   * - If ports change, UFW rules are updated via the bridge.
   */
  fast.put(
    '/api/v1/servers/:id/settings',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.update_settings', resource: 'server' },
      },
      schema: { params: idParam, body: serverSettingsUpdate },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;

      // --- load server row ---
      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const currentSettings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, id),
      });
      if (!currentSettings) {
        reply.code(404);
        return { error: 'settings_not_found' };
      }

      // --- detect which ports (if any) are being changed ---
      const portChange: Partial<Record<PortField, number>> = {};
      for (const field of PORT_FIELDS) {
        const newVal = body[field];
        if (newVal !== undefined) {
          const currentVal = currentSettings[
            field === 'game_port'
              ? 'gamePort'
              : field === 'query_port'
                ? 'queryPort'
                : field === 'beacon_port'
                  ? 'beaconPort'
                  : 'rconPort'
          ] as number;
          if (newVal !== currentVal) {
            portChange[field] = newVal;
          }
        }
      }

      const hasPortChange = Object.keys(portChange).length > 0;

      // --- guard: ports only changeable when server is not running ---
      if (hasPortChange && !PORT_CHANGEABLE_STATUSES.has(server.status)) {
        reply.code(409);
        return {
          error: 'server_running',
          message: 'Port changes are only allowed when the server is stopped or ready.',
        };
      }

      // --- compute the effective full set of ports after the update ---
      const effectiveGamePort = body.game_port ?? currentSettings.gamePort;
      const effectiveQueryPort = body.query_port ?? currentSettings.queryPort;
      const effectiveBeaconPort = body.beacon_port ?? currentSettings.beaconPort;
      const effectiveRconPort = body.rcon_port ?? currentSettings.rconPort;

      if (hasPortChange) {
        // same-server uniqueness is already enforced by the schema refine() but
        // only for the ports provided in the body — we must check the merged set.
        const allPorts = [
          effectiveGamePort,
          effectiveQueryPort,
          effectiveBeaconPort,
          effectiveRconPort,
        ];
        if (new Set(allPorts).size !== allPorts.length) {
          reply.code(409);
          return { error: 'duplicate_ports', message: 'All four server ports must be distinct.' };
        }

        // cross-server conflict: any port that changed must not exist on another server
        const changedPortValues = Object.values(portChange);
        const conflictRows = await app.db
          .select({ serverId: serverSettings.serverId })
          .from(serverSettings)
          .innerJoin(servers, eq(serverSettings.serverId, servers.id))
          .where(
            and(
              ne(serverSettings.serverId, id),
              isNull(servers.deletedAt),
              or(
                ...changedPortValues.map((p) =>
                  or(
                    eq(serverSettings.gamePort, p),
                    eq(serverSettings.queryPort, p),
                    eq(serverSettings.beaconPort, p),
                    eq(serverSettings.rconPort, p),
                  ),
                ),
              ),
            ),
          )
          .limit(1);

        if (conflictRows.length > 0) {
          reply.code(409);
          return {
            error: 'port_conflict',
            message: 'One or more ports are already in use by another server.',
          };
        }
      }

      // --- build the update set ---
      const updateSet: Partial<typeof serverSettings.$inferInsert> = {};

      if (body.game_port !== undefined) updateSet.gamePort = body.game_port;
      if (body.query_port !== undefined) updateSet.queryPort = body.query_port;
      if (body.beacon_port !== undefined) updateSet.beaconPort = body.beacon_port;
      if (body.rcon_port !== undefined) updateSet.rconPort = body.rcon_port;
      if (body.max_players !== undefined) updateSet.maxPlayers = body.max_players;
      if (body.tickrate !== undefined) updateSet.tickrate = body.tickrate;
      if (body.multihome !== undefined) updateSet.multihome = body.multihome ?? null;
      if (body.extra_args !== undefined) updateSet.extraArgs = body.extra_args;
      if ('cpu_affinity' in body) updateSet.cpuAffinity = body.cpu_affinity ?? null;
      if ('cpu_weight' in body) updateSet.cpuWeight = body.cpu_weight ?? null;
      if ('niceness' in body) updateSet.niceness = body.niceness ?? null;
      if ('memory_high_mb' in body) updateSet.memoryHighMb = body.memory_high_mb ?? null;
      if ('memory_max_mb' in body) updateSet.memoryMaxMb = body.memory_max_mb ?? null;
      if ('io_weight' in body) updateSet.ioWeight = body.io_weight ?? null;

      // --- apply UFW rule updates for changed ports (remove old, add new) ---
      if (hasPortChange) {
        // Remove old port rules for changed ports
        const portToProto: Record<PortField, 'udp' | 'tcp'> = {
          game_port: 'udp',
          query_port: 'udp',
          beacon_port: 'udp',
          rcon_port: 'tcp',
        };
        for (const field of PORT_FIELDS) {
          if (portChange[field] !== undefined) {
            const oldPort =
              field === 'game_port'
                ? currentSettings.gamePort
                : field === 'query_port'
                  ? currentSettings.queryPort
                  : field === 'beacon_port'
                    ? currentSettings.beaconPort
                    : currentSettings.rconPort;
            await app.bridge.ufwRule({
              action: 'remove',
              port: oldPort,
              proto: portToProto[field],
            });
          }
        }
        // Add new port rules for changed ports
        for (const field of PORT_FIELDS) {
          const newPort = portChange[field];
          if (newPort !== undefined) {
            await app.bridge.ufwRule({ action: 'add', port: newPort, proto: portToProto[field] });
          }
        }
      }

      // --- persist ---
      await app.db.update(serverSettings).set(updateSet).where(eq(serverSettings.serverId, id));

      // --- return updated settings ---
      const updated = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, id),
      });
      if (!updated) {
        reply.code(500);
        return { error: 'settings_read_failed' };
      }

      return {
        server_id: updated.serverId,
        install_path: updated.installPath,
        game_port: updated.gamePort,
        query_port: updated.queryPort,
        beacon_port: updated.beaconPort,
        rcon_port: updated.rconPort,
        max_players: updated.maxPlayers,
        tickrate: updated.tickrate,
        multihome: updated.multihome,
        extra_args: updated.extraArgs,
        cpu_affinity: updated.cpuAffinity,
        cpu_weight: updated.cpuWeight,
        niceness: updated.niceness,
        memory_high_mb: updated.memoryHighMb,
        memory_max_mb: updated.memoryMaxMb,
        io_weight: updated.ioWeight,
      };
    },
  );

  /**
   * PATCH /api/v1/servers/:id
   * Updates server metadata: display_name, description, tags.
   */
  fast.patch(
    '/api/v1/servers/:id',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.patch', resource: 'server' },
      },
      schema: { params: idParam, body: serverPatch },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;

      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const updateSet: Partial<typeof servers.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (body.display_name !== undefined) updateSet.displayName = body.display_name;
      if ('description' in body) updateSet.description = body.description ?? null;
      if (body.tags !== undefined) updateSet.tags = body.tags;

      await app.db.update(servers).set(updateSet).where(eq(servers.id, id));

      if (body.license_id !== undefined || body.license_key !== undefined) {
        const credUpdate: Record<string, unknown> = {};
        if (body.license_id !== undefined) credUpdate.licenseId = body.license_id;
        if (body.license_key !== undefined) {
          credUpdate.licenseKeyEncrypted = body.license_key
            ? serialize(encrypt(app.encryptionKey, body.license_key))
            : null;
        }
        if (Object.keys(credUpdate).length > 0) {
          await app.db
            .update(serverCredentials)
            .set(credUpdate)
            .where(eq(serverCredentials.serverId, id));
        }
      }

      const updated = await app.db.query.servers.findFirst({
        where: eq(servers.id, id),
      });
      if (!updated) {
        reply.code(500);
        return { error: 'server_read_failed' };
      }

      return {
        id: updated.id,
        display_name: updated.displayName,
        slug: updated.slug,
        description: updated.description,
        status: updated.status,
        tags: updated.tags,
        created_at: updated.createdAt,
        updated_at: updated.updatedAt,
      };
    },
  );
};

export default serverSettingsRoutes;
