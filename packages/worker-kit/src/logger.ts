import pino, { type Logger } from 'pino';

/**
 * Creates a worker's JSON logger: level from `LOG_LEVEL` (default `info`) and
 * every line tagged with `service: "worker-<name>"`.
 *
 * @param name - The worker name without the `worker-` prefix, e.g. `role-expirer`.
 * @returns A pino logger.
 */
export function createWorkerLog(name: string): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: `worker-${name}` },
  });
}
