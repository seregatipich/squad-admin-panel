import {
  rconCommandRequestSchema,
  rconCommandResultKey,
  rconCommandResultSchema,
  rconCommandStream,
} from '@squad/shared-types';
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

export type ConfirmedAdminsCfgReloadOutcome =
  | 'confirmed'
  | 'unavailable'
  | 'rejected'
  | 'timeout'
  | 'invalid_result';

export interface ConfirmAdminsCfgReloadOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Deterministic injection for tests; production creates a fresh UUID. */
  attemptId?: string;
}

/**
 * Ask worker-rcon to run `AdminReloadServerConfig` on a server after the panel
 * has just rewritten its `Admins.cfg` managed segment, so permission changes
 * take effect without a container restart (SYNC-3 correction №1).
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

/**
 * Enqueue and durably verify the reload for one correlated delivery attempt.
 * Every replay gets a new request id: accepting a cached result from a prior
 * attempt could mark a newly rewritten file applied without reloading it.
 */
export async function confirmAdminsCfgReload(
  redis: Pick<Redis, 'get' | 'xadd'>,
  serverId: string,
  outboxId: string,
  log: Logger,
  opts: ConfirmAdminsCfgReloadOptions = {},
): Promise<ConfirmedAdminsCfgReloadOutcome> {
  const requestId = `admins-cfg-sync:${outboxId}:${opts.attemptId ?? uuidv7()}`;
  const resultKey = rconCommandResultKey(requestId);

  const readResult = async (): Promise<ConfirmedAdminsCfgReloadOutcome | null> => {
    const raw = await redis.get(resultKey);
    if (!raw) return null;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return 'invalid_result';
    }
    const parsed = rconCommandResultSchema.safeParse(parsedJson);
    if (!parsed.success) return 'invalid_result';
    const result = parsed.data;
    if (
      result.server_id !== serverId ||
      result.request_id !== requestId ||
      result.command !== 'AdminReloadServerConfig'
    ) {
      return 'invalid_result';
    }
    return result.ok ? 'confirmed' : 'rejected';
  };

  try {
    const request = rconCommandRequestSchema.parse({
      request_id: requestId,
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

    const timeoutMs = opts.timeoutMs ?? 4_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const outcome = await readResult();
      if (outcome) return outcome;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, Math.min(pollIntervalMs, remaining))),
      );
    }
    return 'timeout';
  } catch {
    log.warn({ serverId, outboxId }, 'admins.cfg confirmed RCON reload unavailable');
    return 'unavailable';
  }
}
