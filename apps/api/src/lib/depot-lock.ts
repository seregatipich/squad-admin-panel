import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Fleet-wide mutex for SteamCMD depot updates. Both the fleet depot update
 * (`routes/depot.ts`) and the per-server game update (`routes/server-update.ts`)
 * rewrite the one shared `squad-depot` volume, so only one of them may run at a
 * time. `/start`, `/restart`, `/install`, the rotation calendar and the
 * scheduler worker only test the key for existence.
 */
export const DEPOT_LOCK_KEY = 'depot:updating';

/** Lifetime of the key between renewals; bounds how long a crashed API process blocks updates. */
export const DEPOT_LOCK_TTL_SECONDS = 3600;

/** How often a held lock pushes its expiry forward again. */
export const DEPOT_LOCK_RENEW_INTERVAL_MS = 60_000;

// Compare-and-delete / compare-and-expire: the key is only touched while it
// still holds this holder's token, so a run whose lock was lost can never
// release or extend the lock another run acquired afterwards.
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export interface DepotLockOptions {
  /** Key lifetime in seconds; defaults to {@link DEPOT_LOCK_TTL_SECONDS}. */
  ttlSeconds?: number;
  /** Renewal period in milliseconds; defaults to {@link DEPOT_LOCK_RENEW_INTERVAL_MS}. */
  renewIntervalMs?: number;
  /** Called when a renewal round-trip fails; the next tick retries. */
  onRenewError?: (error: unknown) => void;
}

export interface DepotLock {
  /** ISO timestamp the lock was taken at — what `already_in_progress` reports as `since`. */
  readonly startedAt: string;
  /**
   * Stops renewing and deletes the key if it still holds this lock's token.
   *
   * @returns Whether the key was deleted (false when the lock had already
   *   expired or been taken over by another run).
   */
  release(): Promise<boolean>;
}

/**
 * Reads the start timestamp out of a stored lock value (`<iso> <token>`).
 * Values written before the token was added are a bare ISO timestamp and
 * come back unchanged.
 */
export function depotLockStartedAt(value: string): string {
  return value.split(' ', 1)[0] ?? value;
}

/**
 * Takes the depot lock if nobody holds it and keeps it alive until released.
 *
 * The key carries a random per-holder token and is renewed every
 * `renewIntervalMs` for as long as the holder runs, so a depot update that
 * outlives one TTL (slow server stops plus an hour-long SteamCMD run) keeps
 * the lock. The renewal timer is `unref`'d and never keeps the process alive.
 *
 * @param redis - Connection the lock is taken and renewed on.
 * @param options - TTL, renewal period and renewal-error hook overrides.
 * @returns The held lock, or null when another run already holds it.
 */
export async function acquireDepotLock(
  redis: Redis,
  options: DepotLockOptions = {},
): Promise<DepotLock | null> {
  const ttlMs = (options.ttlSeconds ?? DEPOT_LOCK_TTL_SECONDS) * 1000;
  const startedAt = new Date().toISOString();
  const value = `${startedAt} ${randomUUID()}`;
  const acquired = await redis.set(DEPOT_LOCK_KEY, value, 'PX', ttlMs, 'NX');
  if (!acquired) return null;

  const renewer = setInterval(() => {
    redis
      .eval(RENEW_SCRIPT, 1, DEPOT_LOCK_KEY, value, String(ttlMs))
      .then((renewed) => {
        if (Number(renewed) === 0) clearInterval(renewer);
      })
      .catch((error: unknown) => options.onRenewError?.(error));
  }, options.renewIntervalMs ?? DEPOT_LOCK_RENEW_INTERVAL_MS);
  renewer.unref();

  return {
    startedAt,
    async release() {
      clearInterval(renewer);
      const deleted = await redis.eval(RELEASE_SCRIPT, 1, DEPOT_LOCK_KEY, value);
      return Number(deleted) === 1;
    },
  };
}
