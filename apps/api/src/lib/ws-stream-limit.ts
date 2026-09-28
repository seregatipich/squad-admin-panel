import type { FastifyRequest } from 'fastify';

/**
 * Caps concurrent long-lived WebSocket streams (#1298).
 *
 * Every live log socket makes the root bridge spawn a `docker logs --follow`
 * process, and every depot progress socket opens its own Redis connection. An
 * uncapped route lets a single `server:view` holder exhaust bridge processes
 * and file descriptors or Redis `maxclients` for the whole stack, so each
 * route counts its open streams per caller and in total.
 *
 * Counters live in this API process only; that is the process whose sockets
 * they bound.
 */
export interface StreamLimiter {
  /**
   * Reserves a stream slot for `callerKey`.
   *
   * @returns A release function (safe to call more than once), or null when
   *   the caller or the process is already at its limit.
   */
  acquire(callerKey: string): (() => void) | null;
}

/** WebSocket close code for "try again later" (RFC 6455 §7.4.1). */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * Creates an in-process stream limiter.
 *
 * @param limits.perCaller - Streams one caller may hold open at once.
 * @param limits.total - Streams the route may hold open at once overall.
 */
export function createStreamLimiter(limits: { perCaller: number; total: number }): StreamLimiter {
  const byCaller = new Map<string, number>();
  let total = 0;
  return {
    acquire(callerKey) {
      const held = byCaller.get(callerKey) ?? 0;
      if (held >= limits.perCaller || total >= limits.total) return null;
      byCaller.set(callerKey, held + 1);
      total += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const remaining = (byCaller.get(callerKey) ?? 1) - 1;
        if (remaining <= 0) byCaller.delete(callerKey);
        else byCaller.set(callerKey, remaining);
      };
    },
  };
}

/** The key a stream is counted under: the signed-in player, else the client IP. */
export function streamCallerKey(req: FastifyRequest): string {
  return req.user?.playerId ? `player:${req.user.playerId}` : `ip:${req.ip}`;
}
