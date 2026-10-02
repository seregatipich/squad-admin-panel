/** Readers for the per-server status entries that background workers cache in Redis. */

import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';

/** Seeding state of a server as cached by worker-rcon, as shown in the server list and detail. */
export interface SeedingSummary {
  state: 'seeding' | 'live';
  current_players: number;
  live_at: number;
  progress_pct: number;
  started_at: string | null;
}

/**
 * Reads the `seeding:state:<serverId>` redis cache maintained by
 * worker-rcon's seeding state machine (SEED-1, #140). Returns `null` when
 * the server has no seeding state yet (worker never polled it, or the key
 * expired) so callers can render "unknown" rather than a stale zero.
 */
export async function readSeedingSummary(
  redis: Redis,
  serverId: string,
): Promise<SeedingSummary | null> {
  const raw = await redis.get(`seeding:state:${serverId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      state?: string;
      current_players?: number;
      live_at?: number;
      progress_pct?: number;
      started_at?: string | null;
    };
    if (parsed.state !== 'seeding' && parsed.state !== 'live') return null;
    return {
      state: parsed.state,
      current_players: parsed.current_players ?? 0,
      live_at: parsed.live_at ?? 0,
      progress_pct: parsed.progress_pct ?? 0,
      started_at: parsed.started_at ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Parses a JSON string cached by a background worker (a2s:status:<id>,
 * crashes:<id>) without letting a malformed or partially-written entry crash
 * the whole request. A single bad Redis key must not 500 the entire server
 * list/detail (finding #338) the way the parallel `rcon:status` parse below
 * is already guarded against.
 */
export function safeJsonParse(
  raw: string,
  log: FastifyBaseLogger,
  context: Record<string, unknown>,
) {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    log.warn({ err: (err as Error).message, ...context }, 'failed to parse cached JSON from redis');
    return null;
  }
}

/**
 * Reads the `a2s:status:<id>` entry for the server routes. Worker-rcon
 * (#127) writes `visible: null` when the query port gave no answer; releases
 * before it wrote `visible: false` with `reason: 'timeout'` for the same
 * thing. A timeout says nothing about visibility, so the old shape is
 * normalised to the new one and the panel never shows it as a hidden server.
 *
 * @param value - the parsed cache entry, or `null` when absent or unparseable
 * @returns the entry with `visible: null` and `last_success_at: null` for a legacy timeout, otherwise unchanged
 */
export function normalizeA2sStatus(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  const entry = value as Record<string, unknown>;
  if (entry.visible === false && entry.reason === 'timeout') {
    return { ...entry, visible: null, last_success_at: entry.last_success_at ?? null };
  }
  return value;
}
