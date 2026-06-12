/** Members of this set are served by the RNSquadJS sidecar (production mode);
 *  worker-log-ingest skips them. Empty set = fully legacy. */
export const RNSQUADJS_CUTOVER_SET = 'rnsquadjs:cutover-servers';

/**
 * Minimal Redis interface required by cutover helpers. Real ioredis clients
 * satisfy it; tests can pass a mock.
 */
export interface CutoverRedis {
  smismember(key: string, ...members: string[]): Promise<number[]>;
}

/**
 * Partitions `serverIds` into cutover (sidecar-authoritative) and legacy
 * buckets using a single SMISMEMBER call.
 */
export async function filterCutoverServers(
  redis: CutoverRedis,
  serverIds: string[],
): Promise<{ cutover: string[]; legacy: string[] }> {
  if (serverIds.length === 0) return { cutover: [], legacy: [] };
  const flags = await redis.smismember(RNSQUADJS_CUTOVER_SET, ...serverIds);
  const cutover: string[] = [];
  const legacy: string[] = [];
  serverIds.forEach((id, i) => {
    (flags[i] === 1 ? cutover : legacy).push(id);
  });
  return { cutover, legacy };
}
