import { chown, mkdir, rename, writeFile } from 'node:fs/promises';
import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { serverCredentials } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

const RNSQUADJS_ROOT = '/run/squad-panel/rnsquadjs';
const SIDECAR_UID = 1001;
const SIDECAR_GID = 1001;

export function sidecarConfigPath(serverId: string): string {
  return `${RNSQUADJS_ROOT}/${serverId}/config.json`;
}

export function sidecarSocketPath(serverId: string): string {
  return `${RNSQUADJS_ROOT}/${serverId}/sock/rcon.sock`;
}

export function sidecarContainerName(serverId: string): string {
  return `rnsquadjs-${serverId}`;
}

export type BridgeMode = 'shadow' | 'production';

export interface SidecarEnv {
  SERVER_ID: string;
  LOG_FILE: string;
  PANEL_BRIDGE_MODE: string;
  PANEL_BRIDGE_SOCKET: string;
  REDIS_URL: string;
}

export function buildSidecarEnv(
  serverId: string,
  mode: BridgeMode,
  redisUrl: string | undefined,
): SidecarEnv {
  return {
    SERVER_ID: serverId,
    LOG_FILE: '/squad/Logs/SquadGame.log',
    PANEL_BRIDGE_MODE: mode,
    PANEL_BRIDGE_SOCKET: '/run/panelBridge/rcon.sock',
    REDIS_URL: redisUrl ?? 'redis://127.0.0.1:6379',
  };
}

export interface RnsquadjsContext {
  db: DatabaseClient;
  bridge: Pick<BridgeClient, 'fileRead'>;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export interface RnsquadjsPlugin {
  name: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface RnsquadjsServerConfig {
  id: string;
  host: string;
  port: number;
  password: string;
  logFilePath: string;
  adminsFilePath: string;
  mapsName: string;
  mapsRegExp: string;
  plugins: RnsquadjsPlugin[];
}

export type RnsquadjsConfig = Record<string, RnsquadjsServerConfig>;

const PASSWORD_RE = /^\s*Password\s*=\s*(.*)$/m;

export async function renderRnsquadjsConfig(
  app: RnsquadjsContext,
  serverId: string,
): Promise<RnsquadjsConfig> {
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });
  if (!creds) {
    throw new Error(`rnsquadjs: no credentials found for server ${serverId}`);
  }

  const { content } = await app.bridge.fileRead({
    path: `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/Rcon.cfg`,
  });
  const match = PASSWORD_RE.exec(content);
  if (!match) {
    throw new Error(`rnsquadjs: cannot parse Password from Rcon.cfg for server ${serverId}`);
  }
  const password = match[1]?.trim() ?? '';

  return {
    [serverId]: {
      id: serverId,
      host: '127.0.0.1',
      port: creds.rconPort,
      password,
      logFilePath: '/squad/Logs/SquadGame.log',
      adminsFilePath: '/squad/SquadGame/ServerConfig/Admins.cfg',
      mapsName: 'vanilla.json',
      mapsRegExp: '',
      plugins: [{ name: 'panelBridge', enabled: true, options: {} }],
    },
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

export async function writeSidecarConfig(
  app: RnsquadjsContext,
  serverId: string,
  deps: FsOps = realFsOps,
): Promise<void> {
  const config = await renderRnsquadjsConfig(app, serverId);
  const json = JSON.stringify(config, null, 2);

  const dir = `${RNSQUADJS_ROOT}/${serverId}`;
  const finalPath = sidecarConfigPath(serverId);
  const tmpPath = `${finalPath}.tmp`;

  await deps.mkdir(dir, { recursive: true, mode: 0o755 });
  await deps.writeFile(tmpPath, json, { mode: 0o600 });

  // chown before rename so the sidecar (uid 1001) can read the file on arrival
  try {
    await deps.chown(tmpPath, SIDECAR_UID, SIDECAR_GID);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      // In a non-root dev environment chown is unavailable; the rename still
      // delivers the config so the sidecar can start (with relaxed ownership).
      app.log.warn({ serverId, err }, 'rnsquadjs: chown not permitted — ownership not set');
    } else {
      throw err;
    }
  }

  // Atomic rename: the bridge requires a regular file at sidecar launch;
  // a half-written tmp file must never be visible at the final path.
  await deps.rename(tmpPath, finalPath);
}
