import type Redis from 'ioredis';

/**
 * Redis key of the host-wide depot update lock. Its value is the ISO time the
 * holder started, which doubles as the holder's ownership token: `SET NX`
 * guarantees no two holders share it.
 */
export const DEPOT_LOCK_KEY = 'depot:updating';

/**
 * Lock lifetime. Twice the bridge client's `depot_update` timeout (1 h), so
 * the lock cannot expire while its holder is still waiting on SteamCMD and let
 * a second update write the same volume. The holder releases it when done; the
 * TTL only frees a lock whose API process died.
 */
export const DEPOT_LOCK_TTL_SECONDS = 2 * 60 * 60;

// Deletes the key only while it still holds the caller's token.
const RELEASE_IF_OWNED = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/**
 * Takes the depot lock.
 *
 * @param redis - Redis connection.
 * @param token - The holder's start time (ISO string); pass it to `releaseDepotLock`.
 * @returns True when the lock was free and is now held.
 */
export async function acquireDepotLock(redis: Pick<Redis, 'set'>, token: string): Promise<boolean> {
  return (await redis.set(DEPOT_LOCK_KEY, token, 'EX', DEPOT_LOCK_TTL_SECONDS, 'NX')) === 'OK';
}

/**
 * Releases the depot lock if, and only if, the caller still owns it: a lock
 * another update has taken since is left alone.
 *
 * @param redis - Redis connection.
 * @param token - The value passed to `acquireDepotLock`.
 * @returns True when the key was deleted.
 */
export async function releaseDepotLock(
  redis: Pick<Redis, 'eval'>,
  token: string,
): Promise<boolean> {
  return (await redis.eval(RELEASE_IF_OWNED, 1, DEPOT_LOCK_KEY, token)) === 1;
}
