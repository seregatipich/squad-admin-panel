import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { serverPatch, serverSettingsUpdate } from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { encrypt, serialize } from '../lib/crypto.js';
import { syncLicenseCfg } from '../lib/license-cfg.js';
import { hasContainerPortConflict } from '../lib/server-ports.js';
import { isExternalRuntime } from '../lib/server-runtime.js';

const idParam = z.object({ id: z.string().uuid() });

/** Statuses that allow port changes (server is not running). */
const PORT_CHANGEABLE_STATUSES = new Set(['stopped', 'ready', 'pending', 'failed']);

/** Fields that map to a port column for conflict-checking and UFW updates. */
const PORT_FIELDS = ['game_port', 'query_port', 'beacon_port', 'rcon_port'] as const;
type PortField = (typeof PORT_FIELDS)[number];

/** Firewall protocol of each port field. */
const PORT_PROTO: Record<PortField, 'udp' | 'tcp'> = {
  game_port: 'udp',
  query_port: 'udp',
  beacon_port: 'udp',
  rcon_port: 'tcp',
};

/** Port column of each port field. */
const PORT_COLUMN = {
  game_port: 'gamePort',
  query_port: 'queryPort',
  beacon_port: 'beaconPort',
  rcon_port: 'rconPort',
} as const satisfies Record<PortField, keyof typeof serverSettings.$inferSelect>;

/** One UFW rule as the bridge `ufw_rule` call takes it (minus the action). */
interface UfwRuleSpec {
  port: number;
  proto: 'udp' | 'tcp';
}

/**
 * Rules a port change must add and remove. A rule both the old and the new
 * port set need (a port moved from one field to another with the same
 * protocol) is neither added nor removed, so closing the old ports never
 * closes one the server still uses and a rollback never closes a rule that
 * existed before.
 *
 * @param current - The settings row before the change.
 * @param portChange - Fields whose port actually changes, with the new value.
 */
function ufwRuleChanges(
  current: typeof serverSettings.$inferSelect,
  portChange: Partial<Record<PortField, number>>,
): { toAdd: UfwRuleSpec[]; toRemove: UfwRuleSpec[] } {
  const key = (rule: UfwRuleSpec) => `${rule.port}/${rule.proto}`;
  const oldRules = PORT_FIELDS.map((field) => ({
    port: current[PORT_COLUMN[field]],
    proto: PORT_PROTO[field],
  }));
  const newRules = PORT_FIELDS.map((field) => ({
    port: portChange[field] ?? current[PORT_COLUMN[field]],
    proto: PORT_PROTO[field],
  }));
  const oldKeys = new Set(oldRules.map(key));
  const newKeys = new Set(newRules.map(key));
  return {
    toAdd: newRules.filter((rule) => !oldKeys.has(key(rule))),
    toRemove: oldRules.filter((rule) => !newKeys.has(key(rule))),
  };
}

const serverSettingsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * PUT /api/v1/servers/:id/settings
   * Partially updates the server_settings row.
   * - Port changes only allowed when server is stopped/ready/pending/failed.
   * - `extra_args` and the resource-limit fields (cpu_affinity, cpu_weight,
   *   niceness, memory_high_mb, memory_max_mb, io_weight) are stored and
   *   returned only: no `container_run` call passes them, so they have no
   *   effect on the running server.
   * - New ports must not conflict with other active servers' ports.
   * - Same-server ports (across all four port fields) must all be distinct.
   * - If ports change, the new UFW rules are added first (a failure rolls
   *   them back and answers 502 `ufw_update_failed` with nothing saved), then
   *   the row is saved, then the old rules are removed.
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
        if (newVal !== undefined && newVal !== currentSettings[PORT_COLUMN[field]]) {
          portChange[field] = newVal;
        }
      }

      const hasPortChange = Object.keys(portChange).length > 0;

      // --- guard: an external server's ports describe a remote host and are
      // edited through PUT /external-connection (no UFW, no container) ---
      if (hasPortChange && isExternalRuntime(server.runtime)) {
        reply.code(409);
        return {
          error: 'external_server',
          message: 'Ports of an external server are changed via PUT /external-connection.',
        };
      }

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
        if (await hasContainerPortConflict(app.db, changedPortValues, id)) {
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
      if (body.chat_commands_enabled !== undefined)
        updateSet.chatCommandsEnabled = body.chat_commands_enabled;
      if ('rules_text' in body) updateSet.rulesText = body.rules_text ?? null;
      if (body.archive_logs_to_backup !== undefined)
        updateSet.archiveLogsToBackup = body.archive_logs_to_backup;

      // --- open new ports, persist, then close old ports ---
      // Order matters: until the DB points at the new ports the old ones must
      // stay open, and a failed `add` must leave host and DB as they were.
      const { toAdd, toRemove } = ufwRuleChanges(currentSettings, portChange);
      const added: UfwRuleSpec[] = [];
      try {
        for (const rule of toAdd) {
          await app.bridge.ufwRule({ action: 'add', ...rule });
          added.push(rule);
        }
      } catch (err) {
        for (const rule of added) {
          await app.bridge.ufwRule({ action: 'remove', ...rule }).catch((rollbackErr) => {
            req.log.warn({ err: rollbackErr, rule }, 'ufw rollback of added rule failed');
          });
        }
        req.log.error({ err, id }, 'ufw rule add failed; port change aborted');
        reply.code(502);
        return {
          error: 'ufw_update_failed',
          message: 'Opening the new ports failed; the previous ports are unchanged.',
        };
      }

      await app.db.update(serverSettings).set(updateSet).where(eq(serverSettings.serverId, id));

      for (const rule of toRemove) {
        await app.bridge.ufwRule({ action: 'remove', ...rule }).catch((err) => {
          // The server already uses the new ports; a leftover rule only keeps
          // an unused port open, which must not fail the saved change.
          req.log.warn({ err, rule, id }, 'ufw removal of old port rule failed');
        });
      }

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
        chat_commands_enabled: updated.chatCommandsEnabled,
        rules_text: updated.rulesText,
        archive_logs_to_backup: updated.archiveLogsToBackup,
      };
    },
  );

  /**
   * PATCH /api/v1/servers/:id
   * Updates server metadata (display_name, description, tags) and the server
   * license (SRV-6, #45). A license change is persisted to server_credentials
   * (key encrypted, license_updated_at stamped) and then synced to disk as
   * License.cfg via syncLicenseCfg — a requires_restart file, so no reload is
   * fired; the UI derives a restart badge from license_updated_at instead.
   * `attachValidation` lets the serverPatch `license_incomplete` zod refine
   * map to 422 instead of fastify's default validation 400.
   */
  fast.patch(
    '/api/v1/servers/:id',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.patch', resource: 'server' },
      },
      schema: { params: idParam, body: serverPatch },
      attachValidation: true,
    },
    async (req, reply) => {
      if (req.validationError) {
        const issues = (req.validationError.validation ?? []) as Array<{ message?: string }>;
        if (issues.some((issue) => issue.message === 'license_incomplete')) {
          reply.code(422);
          return { error: 'license_incomplete' };
        }
        throw req.validationError;
      }
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
        const credUpdate: Partial<typeof serverCredentials.$inferInsert> = {};
        if (body.license_key === null) {
          // Detach: clear the whole license; syncLicenseCfg writes the
          // comment-only placeholder to disk.
          credUpdate.licenseId = null;
          credUpdate.licenseKeyEncrypted = null;
          credUpdate.licenseUpdatedAt = null;
        } else {
          const creds = await app.db.query.serverCredentials.findFirst({
            where: eq(serverCredentials.serverId, id),
          });
          if (body.license_id !== undefined) credUpdate.licenseId = body.license_id;
          if (body.license_key !== undefined) {
            credUpdate.licenseKeyEncrypted = serialize(
              encrypt(app.encryptionKey, body.license_key),
            );
          }
          // Stamp only when a key ends up stored — an id saved without any key
          // changes nothing Squad can apply, so no restart badge.
          const willHaveKey = body.license_key !== undefined || creds?.licenseKeyEncrypted != null;
          credUpdate.licenseUpdatedAt = willHaveKey ? new Date() : null;
        }
        await app.db
          .update(serverCredentials)
          .set(credUpdate)
          .where(eq(serverCredentials.serverId, id));
        await syncLicenseCfg(app, id, req.user?.playerId ?? null, req.ip ?? null);
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
