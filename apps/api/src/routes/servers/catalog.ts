import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { canViewIps, redactPayloadIp } from '../../lib/ip-visibility.js';
import { isExternalRuntime } from '../../lib/server-runtime.js';
import { containerName, serverIdParams } from '../../lib/servers/common.js';
import {
  normalizeA2sStatus,
  readSeedingSummary,
  safeJsonParse,
} from '../../lib/servers/status-cache.js';

const HOST_INFO_TTL_MS = 60_000;

/** Server list, detail and event feed reads. */
const serverCatalogRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  let hostInfoCache: { value: { address: string; hostname: string }; at: number } | null = null;
  async function getHostAddress(): Promise<{ address: string; hostname: string } | null> {
    if (hostInfoCache && Date.now() - hostInfoCache.at < HOST_INFO_TTL_MS) {
      return hostInfoCache.value;
    }
    try {
      const info = await app.bridge.hostInfo();
      const value = { address: info.hostname, hostname: info.hostname };
      hostInfoCache = { value, at: Date.now() };
      return value;
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'hostInfo failed');
      return null;
    }
  }

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
        .where(isNull(servers.deletedAt))
        .orderBy(servers.displayName);
      const items = await Promise.all(
        rows.map(async (r) => {
          // #339: these three reads are independent — running them
          // sequentially costs N·3 round trips for a list of N servers.
          const [raw, a2sRaw, seeding] = await Promise.all([
            app.redis.get(`rcon:status:${r.id}`),
            app.redis.get(`a2s:status:${r.id}`),
            readSeedingSummary(app.redis, r.id),
          ]);
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
            a2s_status: a2sRaw
              ? normalizeA2sStatus(
                  safeJsonParse(a2sRaw, app.log, { serverId: r.id, key: 'a2s:status' }),
                )
              : null,
            crash_loop: r.status === 'failed',
            seeding,
          };
        }),
      );
      return { items, total: items.length };
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
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      // #339: these four reads (two DB, two Redis) are independent of each
      // other — fetching them sequentially only adds latency.
      const [settingsRow, credsRow, rconRaw, a2sRaw] = await Promise.all([
        app.db.query.serverSettings.findFirst({
          where: eq(serverSettings.serverId, req.params.id),
        }),
        app.db.query.serverCredentials.findFirst({
          where: eq(serverCredentials.serverId, req.params.id),
        }),
        app.redis.get(`rcon:status:${row.id}`),
        app.redis.get(`a2s:status:${row.id}`),
      ]);
      let rcon_status: {
        state: string;
        ts?: string;
        player_count?: number;
        last_poll_at?: string;
        backoffMs?: number;
        tickrate_rt?: number;
        current_map?: string;
      } = { state: 'not_polled' };
      if (rconRaw) {
        try {
          rcon_status = JSON.parse(rconRaw);
        } catch {
          rcon_status = { state: 'not_polled' };
        }
      }
      const a2s_status: unknown = a2sRaw
        ? normalizeA2sStatus(
            safeJsonParse(a2sRaw, app.log, { serverId: row.id, key: 'a2s:status' }),
          )
        : null;

      const external = isExternalRuntime(row.runtime);
      const name = containerName(row.id);
      // An external server has no container on this host: skip both bridge
      // round-trips and report its RCON host as the address instead.
      const [inspect, host] = external
        ? [
            null,
            credsRow?.rconHost ? { address: credsRow.rconHost, hostname: credsRow.rconHost } : null,
          ]
        : await Promise.all([
            app.bridge.containerInspect({ name }).catch((err) => {
              app.log.warn({ err: (err as Error).message, name }, 'containerInspect failed');
              return null;
            }),
            getHostAddress(),
          ]);

      const isAlive = !!inspect && inspect.state !== 'not_found' && inspect.running;
      const stats = isAlive
        ? await app.bridge.containerStats({ name }).catch((err) => {
            app.log.warn({ err: (err as Error).message, name }, 'containerStats failed');
            return null;
          })
        : null;

      const container =
        inspect && inspect.state !== 'not_found'
          ? {
              state: inspect.state,
              running: inspect.running,
              started_at: inspect.started_at || null,
              finished_at: inspect.finished_at || null,
              image: inspect.image || null,
              pid: inspect.pid || null,
              restart_count: inspect.restart_count,
              exit_code: inspect.exit_code,
              cpu_percent: stats?.found ? stats.cpu_percent : null,
              mem_used_bytes: stats?.found ? stats.mem_used_bytes : null,
              mem_limit_bytes: stats?.found ? stats.mem_limit_bytes : null,
              mem_percent: stats?.found ? stats.mem_percent : null,
              pids: stats?.found ? stats.pids : null,
            }
          : null;

      const [crashRaw, seeding] = await Promise.all([
        app.redis.zrevrange(`crashes:${row.id}`, 0, 9),
        readSeedingSummary(app.redis, row.id),
      ]);
      const crash_history = crashRaw
        .map((c: string) => safeJsonParse(c, app.log, { serverId: row.id, key: 'crashes' }))
        .filter((entry): entry is unknown => entry !== null);
      const crash_loop = row.status === 'failed';

      // SRV-6 (#45): license *state* only — the key itself never leaves the
      // API. License.cfg is requires_restart, so the license is live only if
      // the container (re)started after license_updated_at.
      const licenseUpdatedAt = credsRow?.licenseUpdatedAt ?? null;
      const license = {
        configured: credsRow?.licenseKeyEncrypted != null,
        license_id: credsRow?.licenseId ?? null,
        updated_at: licenseUpdatedAt ? licenseUpdatedAt.toISOString() : null,
        restart_required:
          licenseUpdatedAt != null &&
          (!container?.running ||
            !container.started_at ||
            new Date(container.started_at).getTime() < licenseUpdatedAt.getTime()),
      };

      return {
        server: {
          id: row.id,
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
          license,
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
              seed_live_at: settingsRow.seedLiveAt,
              seed_hysteresis: settingsRow.seedHysteresis,
              chat_commands_enabled: settingsRow.chatCommandsEnabled,
              rules_text: settingsRow.rulesText,
              archive_logs_to_backup: settingsRow.archiveLogsToBackup,
            }
          : null,
        rcon_status,
        a2s_status,
        container,
        host,
        connection: external
          ? { rcon_host: credsRow?.rconHost ?? null, rcon_port: credsRow?.rconPort ?? null }
          : null,
        crash_history,
        crash_loop,
        seeding,
      };
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
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
        columns: { id: true },
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const includeIps = canViewIps(req);
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
            payload: includeIps ? env.payload : redactPayloadIp(env.payload),
          });
        } catch {
          // ignore bad envelopes
        }
      }
      return { items, total: items.length };
    },
  );
};

export default serverCatalogRoutes;
