import {
  type RconOperatorCommandName,
  rconCommandRequestSchema,
  rconCommandResultKey,
  rconCommandResultSchema,
  rconCommandStream,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

export type WorkerRconCommandOutcome =
  | { attempted: false; reason: 'worker_not_connected' | 'worker_unavailable'; detail?: string }
  | {
      attempted: true;
      ok: true;
      requestId: string;
      response: string;
      via: 'worker-rcon';
    }
  | {
      attempted: true;
      ok: false;
      requestId: string;
      reason: 'timeout' | 'worker_rejected';
      detail?: string;
      via: 'worker-rcon';
    };

export interface SendRconCommandViaWorkerOptions {
  serverId: string;
  command: RconOperatorCommandName;
  args?: string[];
  actorPlayerId?: string | null;
  requestId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Hands one whitelisted RCON command to worker-rcon over Redis and waits for
 * its result. Never throws on a Redis fault:
 * - before the command is enqueued (status check, XADD) a fault is
 *   `{ attempted: false, reason: 'worker_unavailable' }` — nothing was sent;
 * - after enqueue a failed result poll is `{ attempted: true, reason: 'timeout' }`
 *   with the fault in `detail`, because the worker may still run the command
 *   and the caller must not retry it through another path.
 */
export async function sendRconCommandViaWorker(
  redis: Redis,
  opts: SendRconCommandViaWorkerOptions,
): Promise<WorkerRconCommandOutcome> {
  let connected: boolean;
  try {
    connected = await isWorkerRconConnected(redis, opts.serverId);
  } catch (err) {
    return { attempted: false, reason: 'worker_unavailable', detail: (err as Error).message };
  }
  if (!connected) return { attempted: false, reason: 'worker_not_connected' };

  const request = rconCommandRequestSchema.parse({
    request_id: opts.requestId ?? uuidv7(),
    command: opts.command,
    args: opts.args ?? [],
    actor_player_id: opts.actorPlayerId ?? null,
    enqueued_at: new Date().toISOString(),
  });
  try {
    await redis.xadd(
      rconCommandStream(opts.serverId),
      'MAXLEN',
      '~',
      '500',
      '*',
      'request',
      JSON.stringify(request),
    );
  } catch (err) {
    return {
      attempted: false,
      reason: 'worker_unavailable',
      detail: (err as Error).message,
    };
  }

  const resultKey = rconCommandResultKey(request.request_id);
  const timeoutMs = opts.timeoutMs ?? 4000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let pollError: string | undefined;
  while (Date.now() <= deadline) {
    let raw: string | null;
    try {
      raw = await redis.get(resultKey);
    } catch (err) {
      pollError = (err as Error).message;
      raw = null;
    }
    if (raw) {
      await redis.del(resultKey).catch(() => undefined);
      let resultPayload: unknown;
      try {
        resultPayload = JSON.parse(raw);
      } catch (err) {
        return {
          attempted: true,
          ok: false,
          requestId: request.request_id,
          reason: 'worker_rejected',
          detail: (err as Error).message,
          via: 'worker-rcon',
        };
      }
      const parsed = rconCommandResultSchema.safeParse(resultPayload);
      if (!parsed.success) {
        return {
          attempted: true,
          ok: false,
          requestId: request.request_id,
          reason: 'worker_rejected',
          detail: parsed.error.message,
          via: 'worker-rcon',
        };
      }
      if (parsed.data.ok) {
        return {
          attempted: true,
          ok: true,
          requestId: request.request_id,
          response: parsed.data.response ?? '',
          via: 'worker-rcon',
        };
      }
      return {
        attempted: true,
        ok: false,
        requestId: request.request_id,
        reason: 'worker_rejected',
        detail: parsed.data.error,
        via: 'worker-rcon',
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.min(pollIntervalMs, remaining))),
    );
  }

  return {
    attempted: true,
    ok: false,
    requestId: request.request_id,
    reason: 'timeout',
    ...(pollError === undefined ? {} : { detail: pollError }),
    via: 'worker-rcon',
  };
}

async function isWorkerRconConnected(redis: Redis, serverId: string): Promise<boolean> {
  const raw = await redis.get(`rcon:status:${serverId}`);
  if (!raw) return false;
  try {
    const status = JSON.parse(raw) as { state?: unknown };
    return status.state === 'connected';
  } catch {
    return false;
  }
}
