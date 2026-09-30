import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

/** Hard-coded historical default, kept as the fallback for every caller that does not set `DATABASE_POOL_MAX`. */
const DEFAULT_POOL_MAX = 16;

/**
 * Every process that calls this (the API, plus log-ingest, rcon, discord,
 * automation and config-sync, each with their own pool) used to hard-code
 * `max: 16` with no way to size it down. Summed across every process the
 * panel runs, that pool budget (~130+ connections) comfortably exceeds
 * Postgres's un-tuned `max_connections` default of 100, so a load spike can
 * starve everything else — including an operator's own `psql` and the
 * migrator — of a connection (#1097).
 *
 * `DATABASE_POOL_MAX`, when set, overrides the per-process pool size; a
 * worker deployment can set it to 2–4 while the API keeps a larger pool,
 * without a code change. See `.env.example` for the recommended budget.
 */
function resolvePoolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX;
  if (!raw) return DEFAULT_POOL_MAX;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_MAX;
}

export function createDatabaseClient(url: string) {
  const sql = postgres(url, {
    max: resolvePoolMax(),
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  return drizzle(sql, { schema });
}

export { schema };
