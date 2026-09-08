/**
 * Engine-neutral Redis keys and helpers for the per-server sidecar.
 *
 * The panel runs two sidecar engines during the SquadJS2 migration. Which one a
 * server uses is desired state held in {@link SQUADJS2_ENGINE_SET}; whether the
 * sidecar owns that server's log pipeline stays a separate question answered by
 * `RNSQUADJS_CUTOVER_SET` (see `./rnsquadjs.js`), whose semantics in
 * worker-log-ingest are unchanged by the migration.
 */

/** Members of this set run the SquadJS2 sidecar; non-members run RNSquadJS. */
export const SQUADJS2_ENGINE_SET = 'squadjs2:engine-servers';

/** Sidecar engine that serves one server. */
export type SidecarEngine = 'squadjs2' | 'rnsquadjs';

/** Which key namespace a sidecar publishes into. */
export type SidecarMode = 'production' | 'shadow';

/**
 * Key holding the sidecar's own view of its RCON connection.
 *
 * Engine-neutral by design: `rcon:status:{id}` belongs to worker-rcon (D4) and
 * the legacy `rnsquadjs:status:*` key is read only as a migration fallback.
 *
 * @param serverId - Panel server UUID.
 * @param mode - Sidecar mode; shadow mode uses a separate key.
 * @returns The Redis key.
 */
export function sidecarStatusKey(serverId: string, mode: SidecarMode): string {
  return `sidecar:status:${serverId}${mode === 'shadow' ? ':shadow' : ''}`;
}

/**
 * Legacy per-server sidecar status key written by the RNSquadJS bridge.
 *
 * Read-only fallback for servers whose sidecar has not been replaced yet;
 * removed with the rest of the RNSquadJS path.
 *
 * @param serverId - Panel server UUID.
 * @param mode - Sidecar mode; shadow mode uses a separate key.
 * @returns The Redis key.
 */
export function legacySidecarStatusKey(serverId: string, mode: SidecarMode): string {
  return `rnsquadjs:status:${serverId}${mode === 'shadow' ? ':shadow' : ''}`;
}

/**
 * Key holding the sidecar's liveness heartbeat.
 *
 * @param serverId - Panel server UUID.
 * @returns The Redis key.
 */
export function sidecarHeartbeatKey(serverId: string): string {
  return `worker:heartbeat:sidecar:${serverId}`;
}

/** Container name of one engine's sidecar for a server. */
export function sidecarContainerName(engine: SidecarEngine, serverId: string): string {
  return `${engine}-${serverId}`;
}

/** Host directory holding one engine's rendered per-server config. */
export function sidecarConfigDir(engine: SidecarEngine, serverId: string): string {
  return `/run/squad-panel/${engine}/${serverId}`;
}

/** Minimal Redis surface the engine helpers need. */
export interface SidecarEngineRedis {
  sismember(key: string, member: string): Promise<number>;
}

/**
 * Resolves which sidecar engine serves a server.
 *
 * @param redis - Redis client.
 * @param serverId - Panel server UUID.
 * @returns `'squadjs2'` for members of {@link SQUADJS2_ENGINE_SET}, else `'rnsquadjs'`.
 */
export async function resolveSidecarEngine(
  redis: SidecarEngineRedis,
  serverId: string,
): Promise<SidecarEngine> {
  return (await redis.sismember(SQUADJS2_ENGINE_SET, serverId)) === 1 ? 'squadjs2' : 'rnsquadjs';
}
