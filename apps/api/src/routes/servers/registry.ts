import { randomBytes } from 'node:crypto';
import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import {
  externalServerConnectionUpdate,
  externalServerCreateInput,
  isPrivateHostAllowed,
  parsePrivateHostAllowlist,
  serverCreateInput,
} from '@squad/shared-types';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { fireAutoPrune } from '../../lib/auto-prune.js';
import { encrypt, serialize } from '../../lib/crypto.js';
import { isUniqueViolation } from '../../lib/pg-errors.js';
import { softDeleteServer } from '../../lib/server-delete.js';
import { hasContainerPortConflict } from '../../lib/server-ports.js';
import { isExternalRuntime } from '../../lib/server-runtime.js';
import { serverIdParams } from '../../lib/servers/common.js';

/**
 * Whether an external server's RCON host passes the private-LAN allowlist
 * (`EXTERNAL_HOST_PRIVATE_ALLOWLIST`, audit #333). Unset keeps every LAN
 * address reachable; a hostname is checked by worker-rcon once it resolves.
 */
function isRconHostPermitted(allowlistSetting: string | undefined, host: string): boolean {
  return isPrivateHostAllowed(host, parsePrivateHostAllowlist(allowlistSetting));
}

/** 400 body for an RCON host that is a private address outside the allowlist. */
const PRIVATE_RCON_HOST_REFUSED = {
  error: 'rcon_host_private_not_allowed',
  message:
    'Адрес RCON находится в частной сети, которой нет в списке разрешённых (EXTERNAL_HOST_PRIVATE_ALLOWLIST).',
} as const;

/** Advisory-lock key serializing port checks with server creation in `POST /api/v1/servers`. */
const SERVER_PORT_ALLOCATION_LOCK = 'server-port-allocation';

/** Server registration (managed and external), external-connection edits and deletion. */
const serverRegistryRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers',
    {
      config: {
        permissions: ['server:install'],
        audit: { action: 'server.create', resource: 'server' },
      },
      schema: { body: serverCreateInput },
    },
    async (req, reply) => {
      const id = uuidv7();
      const body = req.body;

      const requestedPorts = [body.game_port, body.query_port, body.beacon_port, body.rcon_port];

      try {
        const portConflict = await app.db.transaction(async (tx) => {
          // Port uniqueness is not a DB constraint, so the check and the insert
          // are serialized under one transaction-scoped lock: without it two
          // concurrent creates both pass the check and bind the same ports.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${SERVER_PORT_ALLOCATION_LOCK}))`,
          );
          if (await hasContainerPortConflict(tx, requestedPorts)) return true;
          await tx.insert(servers).values({
            id,
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
          return false;
        });
        if (portConflict) {
          reply.code(409);
          return {
            error: 'port_conflict',
            message: 'One or more ports are already in use by another server.',
          };
        }
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: 'slug_in_use', message: 'An active server already uses this slug.' };
        }
        throw err;
      }
      reply.code(201);
      return { id, status: 'pending' };
    },
  );

  /**
   * Registers a Squad server the panel does not host. Nothing is installed
   * and no bridge call is made: the row is born `running` with
   * `runtime='external'`, and worker-rcon dials `rcon_host:rcon_port` on its
   * next reconcile (≤15 s). Container-bound routes answer 409
   * `external_server` for it; deletion is a plain soft-delete.
   */
  fast.post(
    '/api/v1/servers/external',
    {
      config: {
        permissions: ['server:install'],
        audit: { action: 'server.create_external', resource: 'server' },
      },
      schema: { body: externalServerCreateInput },
    },
    async (req, reply) => {
      const id = uuidv7();
      const body = req.body;
      if (!isRconHostPermitted(app.config.EXTERNAL_HOST_PRIVATE_ALLOWLIST, body.rcon_host)) {
        reply.code(400);
        return PRIVATE_RCON_HOST_REFUSED;
      }
      try {
        await app.db.transaction(async (tx) => {
          await tx.insert(servers).values({
            id,
            displayName: body.display_name,
            slug: body.slug,
            description: body.description ?? null,
            // Lifecycle belongs to whoever hosts the process; for the panel an
            // external server is up for as long as the row exists, which is
            // exactly the state worker-rcon keys its polling on.
            status: 'running',
            runtime: 'external',
          });
          await tx.insert(serverSettings).values({
            serverId: id,
            // No install tree on this host; the column is NOT NULL.
            installPath: '',
            gamePort: body.game_port,
            queryPort: body.query_port,
            // The beacon port is a container launch argument the panel never
            // uses for an external server; Squad's default keeps the row valid.
            beaconPort: 15_000,
            rconPort: body.rcon_port,
            maxPlayers: body.max_players,
          });
          await tx.insert(serverCredentials).values({
            serverId: id,
            rconHost: body.rcon_host,
            rconPort: body.rcon_port,
            rconPasswordEncrypted: serialize(encrypt(app.encryptionKey, body.rcon_password)),
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: 'slug_in_use', message: 'An active server already uses this slug.' };
        }
        throw err;
      }
      app.liveBus?.publish({
        type: 'server.status',
        ts: new Date().toISOString(),
        data: { server_id: id, status: 'running', source: 'external' },
      });
      reply.code(201);
      return { id, status: 'running', runtime: 'external' };
    },
  );

  /**
   * Edits how the panel reaches an external server. Ports of panel-hosted
   * servers go through `PUT /settings` (they also drive UFW and the container
   * launch), so a container row is refused here with 409 `not_external_server`.
   * The stored password is replaced only when `rcon_password` is present.
   */
  fast.put(
    '/api/v1/servers/:id/external-connection',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.update_external_connection', resource: 'server' },
      },
      schema: { params: serverIdParams, body: externalServerConnectionUpdate },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (!isExternalRuntime(row.runtime)) {
        reply.code(409);
        return {
          error: 'not_external_server',
          message: 'Connection settings apply only to external servers.',
        };
      }
      const body = req.body;
      if (
        body.rcon_host !== undefined &&
        !isRconHostPermitted(app.config.EXTERNAL_HOST_PRIVATE_ALLOWLIST, body.rcon_host)
      ) {
        reply.code(400);
        return PRIVATE_RCON_HOST_REFUSED;
      }
      await app.db.transaction(async (tx) => {
        const creds: Partial<typeof serverCredentials.$inferInsert> = {};
        if (body.rcon_host !== undefined) creds.rconHost = body.rcon_host;
        if (body.rcon_port !== undefined) creds.rconPort = body.rcon_port;
        if (body.rcon_password !== undefined) {
          creds.rconPasswordEncrypted = serialize(encrypt(app.encryptionKey, body.rcon_password));
        }
        if (Object.keys(creds).length > 0) {
          await tx
            .update(serverCredentials)
            .set(creds)
            .where(eq(serverCredentials.serverId, row.id));
        }
        const settings: Partial<typeof serverSettings.$inferInsert> = {};
        if (body.rcon_port !== undefined) settings.rconPort = body.rcon_port;
        if (body.query_port !== undefined) settings.queryPort = body.query_port;
        if (body.game_port !== undefined) settings.gamePort = body.game_port;
        if (body.max_players !== undefined) settings.maxPlayers = body.max_players;
        if (Object.keys(settings).length > 0) {
          await tx.update(serverSettings).set(settings).where(eq(serverSettings.serverId, row.id));
        }
        await tx.update(servers).set({ updatedAt: new Date() }).where(eq(servers.id, row.id));
      });
      const [creds, settings] = await Promise.all([
        app.db.query.serverCredentials.findFirst({
          where: eq(serverCredentials.serverId, row.id),
        }),
        app.db.query.serverSettings.findFirst({ where: eq(serverSettings.serverId, row.id) }),
      ]);
      return {
        id: row.id,
        rcon_host: creds?.rconHost ?? null,
        rcon_port: creds?.rconPort ?? null,
        query_port: settings?.queryPort ?? null,
        game_port: settings?.gamePort ?? null,
        max_players: settings?.maxPlayers ?? null,
        password_updated: body.rcon_password !== undefined,
      };
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
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const actorPlayerId = req.user?.playerId;
      const softDeleteT0 = Date.now();
      await req.diag.emit({
        component: 'api',
        kind: 'server.soft_delete.requested',
        severity: 'info',
        serverId: row.id,
        actorPlayerId,
        message: 'soft-delete requested',
        payload: {},
      });
      try {
        const result = await softDeleteServer(
          {
            db: app.db,
            bridge: app.bridge,
            log: req.log,
            actorPlayerId: req.user?.playerId ?? null,
            actorIp: req.ip ?? null,
            actorLabel: req.user ? `player:${req.user.playerId}` : 'system',
            redis: app.redis,
          },
          row.id,
        );
        app.installProgress.reset(row.id);
        app.liveBus.publish({
          type: 'server.deleted',
          ts: new Date().toISOString(),
          data: {
            server_id: row.id,
            deleted_at: new Date().toISOString(),
            by: req.user?.playerId ?? null,
          },
        });
        await req.diag.emit({
          component: 'api',
          kind: 'server.soft_delete.done',
          severity: 'info',
          serverId: row.id,
          actorPlayerId,
          message: 'soft-delete complete',
          payload: {
            backup_id: result.backup_marker_id,
            files_backed_up: result.files_backed_up,
            durationMs: Date.now() - softDeleteT0,
          },
        });
        // Spec §"deleted means deleted": after the per-server cleanup
        // succeeded we additionally reclaim docker build cache and any
        // dangling images that the squad-server stack left behind. Fire
        // and forget — the response to the operator returns immediately
        // and the prune logs/audits when it completes.
        fireAutoPrune(app, `server.delete:${row.id}`, req.user?.playerId ?? null, req.ip ?? null);
        return { ok: true, ...result };
      } catch (err) {
        const errorMessage = (err as Error).message;
        await req.diag.emit({
          component: 'api',
          kind: 'server.soft_delete.failed',
          severity: 'error',
          serverId: row.id,
          actorPlayerId,
          message: `soft-delete failed: ${errorMessage}`,
          payload: { errorMessage, durationMs: Date.now() - softDeleteT0 },
        });
        reply.code(500);
        return { error: 'delete_failed', message: errorMessage };
      }
    },
  );
};

export default serverRegistryRoutes;
