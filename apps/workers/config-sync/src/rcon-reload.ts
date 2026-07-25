import { rconCommandRequestSchema, rconCommandStream } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';

const RCON_STREAM_MAXLEN = 500;

/**
 * Outcome of a best-effort `AdminReloadServerConfig` enqueue:
 * - `enqueued` — the command was written to `rcon:commands:<serverId>`.
 * - `skipped_rcon_disconnected` — no connected RCON listener, nothing enqueued.
 * - `failed` — an error was caught while enqueuing (never thrown to the caller).
 */
export type AdminsCfgReloadOutcome = 'enqueued' | 'skipped_rcon_disconnected' | 'failed';

/**
 * Ask worker-rcon to run `AdminReloadServerConfig` on a server after the panel
 * has just rewritten its `Admins.cfg` managed segment, so permission changes
 * take effect without a container restart (SYNC-3 correction №1 —
 * `ai_docs/plans/2026-07-04-task-decomposition.md`).
 *
 * The command is enqueued onto worker-rcon's per-server command stream, mirroring
 * the worker-local `sendRconCommand` helpers in clan-guard / log-ingest /
 * scheduler (the API-side helper cannot be imported from a worker package). It is
 * gated on `rcon:status:<serverId>.state === 'connected'`: when no connected
 * listener exists the reload is skipped rather than piling commands onto a stopped
 * server (worker-rcon replays the current config on its next connect anyway).
 *
 * Strictly best-effort — it never throws. Any error (including a Redis write
 * failure) is caught, logged at warn level, and reported as `failed` so the
 * caller's successful `Admins.cfg` write is never rolled back by a reload hiccup.
 *
 * @param redis - Redis client (reads the status key, XADDs the command).
 * @param serverId - the server whose `Admins.cfg` was just written.
 * @param log - pino logger for the warn on failure.
 * @returns the reload {@link AdminsCfgReloadOutcome}.
 */
export async function requestAdminsCfgReload(
  redis: Pick<Redis, 'get' | 'xadd'>,
  serverId: string,
  log: Logger,
): Promise<AdminsCfgReloadOutcome> {
  try {
    const raw = await redis.get(`rcon:status:${serverId}`);
    if (!raw) return 'skipped_rcon_disconnected';
    let state: unknown;
    try {
      state = (JSON.parse(raw) as { state?: unknown }).state;
    } catch {
      // Malformed status payload — treat as "not connected", don't enqueue.
      return 'skipped_rcon_disconnected';
    }
    if (state !== 'connected') return 'skipped_rcon_disconnected';

    const request = rconCommandRequestSchema.parse({
      request_id: uuidv7(),
      command: 'AdminReloadServerConfig',
      args: [],
      actor_player_id: null,
      enqueued_at: new Date().toISOString(),
    });
    await redis.xadd(
      rconCommandStream(serverId),
      'MAXLEN',
      '~',
      String(RCON_STREAM_MAXLEN),
      '*',
      'request',
      JSON.stringify(request),
    );
    return 'enqueued';
  } catch (err) {
    log.warn(
      { serverId, err: (err as Error).message },
      'admins.cfg RCON reload enqueue failed (non-fatal)',
    );
    return 'failed';
  }
}
