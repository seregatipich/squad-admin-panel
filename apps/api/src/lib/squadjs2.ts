import { chown, mkdir, rename, writeFile } from 'node:fs/promises';
import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { serverCredentials, serverSettings } from '@squad/db/schema';
import { RNSQUADJS_CUTOVER_SET, sidecarConfigDir } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import { readRconPassword, resolveSidecarRedisUrl } from './sidecar-config.js';

const SIDECAR_UID = 1001;
const SIDECAR_GID = 1001;

/** Path inside the sidecar container where the panel config is bound read-only. */
export const SQUADJS2_CONTAINER_CONFIG_PATH = '/app/panel-config.json';

/** Squad log file the sidecar tails, as seen inside the container. */
export const SQUADJS2_LOG_FILE = '/squad/Logs/SquadGame.log';

export function squadjs2ConfigPath(serverId: string): string {
  return `${sidecarConfigDir('squadjs2', serverId)}/config.json`;
}

export function squadjs2ContainerName(serverId: string): string {
  return `squadjs2-${serverId}`;
}

export type SidecarMode = 'shadow' | 'production';

/**
 * Environment the bridge is allowed to pass to the SquadJS2 sidecar.
 *
 * Deliberately just the two values the entrypoint itself needs: mode, Redis URL
 * and server id travel in the rendered config, which is the SquadJS idiom and
 * keeps secrets out of `docker inspect`.
 */
export interface Squadjs2Env {
  SERVER_ID: string;
  LOG_FILE: string;
}

export function buildSquadjs2Env(serverId: string): Squadjs2Env {
  return { SERVER_ID: serverId, LOG_FILE: SQUADJS2_LOG_FILE };
}

export interface Squadjs2Context {
  db: DatabaseClient;
  bridge: Pick<BridgeClient, 'fileRead'>;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export interface Squadjs2PluginConfig {
  plugin: 'PanelBridge';
  enabled: true;
  mode: SidecarMode;
  redisUrl: string;
  serverId: string;
}

export interface Squadjs2Config {
  server: {
    id: number;
    host: string;
    queryPort: number;
    rconPort: number;
    rconPassword: string;
    logReaderMode: 'tail';
    logDir: string;
    adminLists: never[];
  };
  connectors: Record<string, never>;
  plugins: Squadjs2PluginConfig[];
  logger: { verboseness: Record<string, number>; colors: Record<string, string> };
}

/**
 * Builds the SquadJS-format config for one server's sidecar.
 *
 * Only `PanelBridge` is ever enabled and `connectors` is always empty, so
 * SquadJS2 initialises no mongoose/sequelize/Discord client (the factory creates
 * connectors lazily, and only for plugins that declare connector options).
 * Plugins that listen on a port (`autoseed-exporter`, `socket-io-api`) are never
 * enabled either: the sidecar runs with `--network host`, so two of them would
 * collide on the same port.
 *
 * `logger.colors` is not decoration — SquadJS2's factory iterates it with
 * `Object.entries`, so omitting the key crashes the boot with a TypeError.
 *
 * @param app - Database, bridge and logger.
 * @param serverId - Panel server UUID.
 * @param mode - Which key namespace the plugin should publish into.
 * @returns The config object, ready to serialise.
 * @throws If the server has no credentials/settings row, or `Rcon.cfg` has no password.
 */
export async function renderSquadjs2Config(
  app: Squadjs2Context,
  serverId: string,
  mode: SidecarMode,
): Promise<Squadjs2Config> {
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });
  if (!creds) {
    throw new Error(`squadjs2: no credentials found for server ${serverId}`);
  }
  const settings = await app.db.query.serverSettings.findFirst({
    where: eq(serverSettings.serverId, serverId),
  });
  if (!settings) {
    throw new Error(`squadjs2: no settings found for server ${serverId}`);
  }

  const rconPassword = await readRconPassword(app.bridge, serverId, 'squadjs2');

  return {
    server: {
      id: 1,
      host: '127.0.0.1',
      queryPort: settings.queryPort,
      rconPort: creds.rconPort,
      rconPassword,
      logReaderMode: 'tail',
      logDir: '/squad/Logs',
      adminLists: [],
    },
    connectors: {},
    plugins: [
      {
        plugin: 'PanelBridge',
        enabled: true,
        mode,
        redisUrl: resolveSidecarRedisUrl(),
        serverId,
      },
    ],
    logger: { verboseness: { SquadServer: 1 }, colors: {} },
  };
}

export interface FsOps {
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<string | undefined>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
}

const realFsOps: FsOps = {
  mkdir: (path, opts) => mkdir(path, opts),
  writeFile: (path, data, opts) => writeFile(path, data, opts),
  rename,
  chown,
};

/**
 * Renders and atomically installs the sidecar config for one server.
 *
 * The file carries the server's plaintext RCON password, so it is written 0600
 * and owned by the sidecar uid; the bridge binds it read-only and the directory
 * itself stays root-owned.
 *
 * @param app - Database, bridge and logger.
 * @param serverId - Panel server UUID.
 * @param mode - Which key namespace the plugin should publish into.
 * @param deps - Filesystem operations; injectable for tests.
 */
export async function writeSquadjs2Config(
  app: Squadjs2Context,
  serverId: string,
  mode: SidecarMode,
  deps: FsOps = realFsOps,
): Promise<void> {
  const config = await renderSquadjs2Config(app, serverId, mode);
  const json = JSON.stringify(config, null, 2);

  const dir = sidecarConfigDir('squadjs2', serverId);
  const finalPath = squadjs2ConfigPath(serverId);
  const tmpPath = `${finalPath}.tmp`;

  await deps.mkdir(dir, { recursive: true, mode: 0o750 });
  await deps.writeFile(tmpPath, json, { mode: 0o600 });

  // chown before rename so the sidecar (uid 1001) can read the file on arrival
  try {
    await deps.chown(tmpPath, SIDECAR_UID, SIDECAR_GID);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      // In a non-root dev environment chown is unavailable; the rename still
      // delivers the config so the sidecar can start (with relaxed ownership).
      app.log.warn({ serverId, err }, 'squadjs2: chown not permitted — ownership not set');
    } else {
      throw err;
    }
  }

  // Atomic rename: the bridge requires a regular file at sidecar launch;
  // a half-written tmp file must never be visible at the final path.
  await deps.rename(tmpPath, finalPath);
}

export interface Squadjs2LaunchContext extends Squadjs2Context {
  redis: Pick<Redis, 'sismember'>;
  bridge: Squadjs2Context['bridge'] & Pick<BridgeClient, 'containerRm' | 'containerRunSquadjs2'>;
}

/**
 * Creates or recreates the SquadJS2 sidecar for one server.
 *
 * The mode still follows `rnsquadjs:cutover-servers`: that set means "the
 * sidecar owns this server's log pipeline" and its meaning in worker-log-ingest
 * is unchanged by the engine migration.
 *
 * @param app - Database, bridge, Redis and logger.
 * @param serverId - Panel server UUID.
 * @param fsDeps - Filesystem operations; injectable for tests.
 * @returns The new container id and the mode it was launched in.
 */
export async function relaunchSquadjs2Sidecar(
  app: Squadjs2LaunchContext,
  serverId: string,
  fsDeps?: FsOps,
): Promise<{ containerId: string; mode: SidecarMode }> {
  const mode: SidecarMode =
    (await app.redis.sismember(RNSQUADJS_CUTOVER_SET, serverId)) === 1 ? 'production' : 'shadow';
  await writeSquadjs2Config(app, serverId, mode, fsDeps);
  await app.bridge.containerRm({ name: squadjs2ContainerName(serverId) }).catch(() => undefined);
  const run = await app.bridge.containerRunSquadjs2({
    server_id: serverId,
    env: { ...buildSquadjs2Env(serverId) },
  });
  return { containerId: run.container_id, mode };
}
