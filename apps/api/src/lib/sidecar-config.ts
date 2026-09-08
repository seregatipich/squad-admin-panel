import type { BridgeClient } from '@squad/bridge-client';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';

/** Bridge surface needed to read a server's Rcon.cfg from the host. */
export type RconCfgReader = Pick<BridgeClient, 'fileRead'>;

const PASSWORD_RE = /^\s*Password\s*=\s*(.*)$/m;

/**
 * Reads a server's RCON password out of its on-host `Rcon.cfg`.
 *
 * The password is never mirrored into the database — `Rcon.cfg` is the single
 * source of truth — so both sidecar engines render their config from it.
 *
 * @param bridge - Bridge client used to read the host file.
 * @param serverId - Panel server UUID.
 * @param engineLabel - Prefix for thrown errors, naming the calling engine.
 * @returns The password with surrounding whitespace stripped.
 * @throws If `Rcon.cfg` has no parseable `Password=` line.
 */
export async function readRconPassword(
  bridge: RconCfgReader,
  serverId: string,
  engineLabel: string,
): Promise<string> {
  const { content } = await bridge.fileRead({
    path: `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/Rcon.cfg`,
  });
  const match = PASSWORD_RE.exec(content);
  if (!match) {
    throw new Error(`${engineLabel}: cannot parse Password from Rcon.cfg for server ${serverId}`);
  }
  return match[1]?.trim() ?? '';
}

/**
 * Resolves the Redis URL the sidecar plugin should connect to.
 *
 * `SIDECAR_REDIS_URL` is the engine-neutral name; `RNSQUADJS_REDIS_URL` stays
 * readable so an existing deployment keeps working across the migration.
 *
 * @param env - Process environment to read.
 * @returns The configured URL, or the loopback default.
 */
export function resolveSidecarRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIDECAR_REDIS_URL ?? env.RNSQUADJS_REDIS_URL ?? 'redis://127.0.0.1:6379';
}
