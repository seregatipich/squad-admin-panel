import type Redis from 'ioredis';

/**
 * Single shared Redis stream for SteamCMD depot-update output. Only one
 * depot update can run at a time across the fleet (guarded by the
 * `depot:updating` lock in server-update.ts / depot.ts), so both the
 * per-server "update game" action and the fleet-wide depot update publish
 * into — and are watched through — this one stream/WS route rather than
 * separate per-caller channels.
 */
export const DEPOT_PROGRESS_STREAM = 'depot:progress';

export async function publishDepotProgressLine(
  redis: Redis,
  stream: string,
  text: string,
): Promise<void> {
  await redis.xadd(
    DEPOT_PROGRESS_STREAM,
    'MAXLEN',
    '~',
    '5000',
    '*',
    'stream',
    stream,
    'text',
    text,
  );
}

/**
 * Marks the end of the currently running depot update. Encoded as a
 * `stream: 'event'` entry (vs. the usual 'stdout'/'stderr') so WS consumers
 * can tell a terminal frame apart from ordinary SteamCMD output.
 */
export async function publishDepotProgressDone(
  redis: Redis,
  final: 'done' | 'error',
  error?: string,
): Promise<void> {
  await redis.xadd(
    DEPOT_PROGRESS_STREAM,
    'MAXLEN',
    '~',
    '5000',
    '*',
    'stream',
    'event',
    'text',
    JSON.stringify(error ? { done: true, final, error } : { done: true, final }),
  );
}
