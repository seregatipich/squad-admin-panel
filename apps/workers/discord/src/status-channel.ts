import type { DatabaseClient } from '@squad/db';
import { players, roles, servers } from '@squad/db/schema';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type Redis from 'ioredis';
import { type DiscordRestDeps, patchChannelName } from './discord-rest.js';

/**
 * DISCORD-6 (#153): the Discord status channel.
 *
 * Every tick each server that has a `status_channel_id` gets its channel
 * renamed to a compact live summary — SQSTAT's `chan_id` model, 16-settings.md
 * §16.3, template `{emoji}{map}_{players}x{queue}_{admins}` (`🟢c_100x7_👮2`).
 *
 * Two rules dominate the design, both from Discord's side:
 *
 * 1. `PATCH /channels/{id}` allows only **two updates per ten minutes per
 *    channel**. The budget is tracked here, in Redis, so it survives a worker
 *    restart — a process-local counter would reset on every deploy and burn the
 *    quota. Exceeding it is not a soft failure: Discord locks the channel out
 *    for minutes, which is exactly the "no 429 in a 24h soak" criterion.
 * 2. A rename that changes nothing still spends budget, so the last applied
 *    name is remembered and an unchanged name issues no request at all. With a
 *    ten-minute tick this leaves one spare rename per window for a map change.
 */

/** Discord's rolling window for channel updates. */
export const STATUS_CHANNEL_RENAME_WINDOW_MS = 600_000;
/** Discord's channel-update allowance inside that window. */
export const STATUS_CHANNEL_MAX_RENAMES_PER_WINDOW = 2;
/** Discord rejects channel names longer than 100 characters. */
const MAX_CHANNEL_NAME_LENGTH = 100;
/** Keeps the map segment short enough that the counters are never truncated away. */
const MAX_MAP_CODE_LENGTH = 24;

const ONLINE_EMOJI = '🟢';
const OFFLINE_EMOJI = '🔴';
const ADMIN_EMOJI = '👮';

/** The subset of the `rcon:status:<serverId>` blob the channel name is built from. */
export interface StatusChannelSnapshot {
  state?: string;
  current_map?: string;
  player_count?: number;
  public_queue?: number;
}

interface RosterCacheEntry {
  steam_id64?: string | null;
}

interface RosterCache {
  players?: RosterCacheEntry[];
}

export interface StatusChannelDeps extends DiscordRestDeps {
  db: DatabaseClient;
  redis: Redis;
  /** Injected so the rename-budget tests can drive the ten-minute window. */
  now: () => number;
}

export interface StatusChannelTickSummary {
  /** Servers that have a status channel configured. */
  considered: number;
  renamed: number;
  unchanged: number;
  rateLimited: number;
  errors: number;
}

export type RenameOutcome = 'renamed' | 'unchanged' | 'rate_limited' | 'error';

/** Tolerant parse of the `rcon:status:<serverId>` cache; a missing or corrupt entry reads as offline. */
export function parseStatusCache(raw: string | null): StatusChannelSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StatusChannelSnapshot;
  } catch {
    return null;
  }
}

/** Tolerant parse of the `rcon:roster:<serverId>` cache written by `worker-rcon`. */
export function parseRosterCache(raw: string | null): RosterCache | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RosterCache;
  } catch {
    return null;
  }
}

/**
 * Shortens a Squad layer name to the channel-name segment: `Gorodok_RAAS_v1`
 * becomes `gorodok`.
 *
 * SQSTAT's own example uses a single letter (`c`), but that mapping is a
 * hand-maintained table of theirs and is not derivable from the layer name, so
 * the readable base name is used instead — the acceptance criterion is that an
 * operator can see the current map, which a one-letter code does not satisfy.
 */
function mapCode(mapName: string | undefined): string {
  const base = (mapName ?? '').split('_')[0] ?? '';
  const cleaned = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, MAX_MAP_CODE_LENGTH) : 'unknown';
}

/**
 * Renders the status-channel name.
 *
 * A server whose RCON status is absent or not `connected` renders as offline
 * with zeroed counters rather than being skipped — a channel silently frozen on
 * yesterday's player count is worse than one that says the server is down.
 */
export function buildStatusChannelName(
  snapshot: StatusChannelSnapshot | null,
  adminCount: number,
): string {
  const online = snapshot?.state === 'connected';
  const emoji = online ? ONLINE_EMOJI : OFFLINE_EMOJI;
  const playerCount = online ? (snapshot?.player_count ?? 0) : 0;
  const queue = online ? (snapshot?.public_queue ?? 0) : 0;
  const name = `${emoji}${mapCode(snapshot?.current_map)}_${playerCount}x${queue}_${ADMIN_EMOJI}${adminCount}`;
  return name.slice(0, MAX_CHANNEL_NAME_LENGTH);
}

/** Counts roster players whose SteamID is in the panel-access set (`👮N` in the template). */
export function countOnlineAdmins(
  roster: RosterCache | null,
  adminSteamIds: ReadonlySet<string>,
): number {
  if (!roster?.players) return 0;
  let count = 0;
  for (const entry of roster.players) {
    const steamId = entry.steam_id64;
    if (steamId && adminSteamIds.has(steamId)) count++;
  }
  return count;
}

/**
 * SteamIDs of every player whose panel role grants `panel_access`.
 *
 * Deliberately the same rule as the slash-command gate, so `👮N` counts the
 * people who could actually act through the panel. The `Owner` short-circuit
 * mirrors `apps/api/src/lib/rbac.ts`, where the system Owner role is treated as
 * having panel access regardless of the column.
 */
export async function loadPanelAccessSteamIds(db: DatabaseClient): Promise<Set<string>> {
  const rows = await db
    .select({ steamId64: players.steamId64 })
    .from(players)
    .innerJoin(roles, eq(players.roleId, roles.id))
    .where(
      and(
        isNotNull(players.steamId64),
        or(eq(roles.panelAccess, true), and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true))),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.steamId64 != null) ids.add(row.steamId64.toString());
  }
  return ids;
}

interface RenameBudget {
  /** Last name successfully applied to the channel. */
  name: string | null;
  /** Epoch-ms timestamps of the renames Discord has seen in the current window. */
  renames: number[];
}

function budgetKey(channelId: string): string {
  return `discord:status-channel:${channelId}`;
}

async function readBudget(deps: StatusChannelDeps, channelId: string): Promise<RenameBudget> {
  const raw = await deps.redis.get(budgetKey(channelId));
  if (!raw) return { name: null, renames: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<RenameBudget>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : null,
      renames: Array.isArray(parsed.renames)
        ? parsed.renames.filter((ts): ts is number => typeof ts === 'number')
        : [],
    };
  } catch {
    return { name: null, renames: [] };
  }
}

/**
 * Applies a name to one channel, honouring both the change check and the
 * two-per-ten-minutes budget. Never throws — a channel an operator mistyped
 * must not stop the other servers' updates.
 */
export async function renameStatusChannel(
  deps: StatusChannelDeps,
  channelId: string,
  desiredName: string,
): Promise<RenameOutcome> {
  const budget = await readBudget(deps, channelId);
  if (budget.name === desiredName) return 'unchanged';

  const now = deps.now();
  const recent = budget.renames.filter((ts) => now - ts < STATUS_CHANNEL_RENAME_WINDOW_MS);
  if (recent.length >= STATUS_CHANNEL_MAX_RENAMES_PER_WINDOW) {
    deps.log.debug(
      { channelId, desiredName, recent: recent.length },
      'status channel rename deferred — Discord budget spent for this window',
    );
    return 'rate_limited';
  }

  const res = await patchChannelName(deps, channelId, desiredName);
  if (!res.ok) {
    deps.log.warn(
      { channelId, reason: res.failure.reason, message: res.failure.message },
      'status channel rename failed',
    );
    return 'error';
  }

  recent.push(now);
  await deps.redis.set(
    budgetKey(channelId),
    JSON.stringify({ name: desiredName, renames: recent } satisfies RenameBudget),
    'EX',
    Math.ceil((STATUS_CHANNEL_RENAME_WINDOW_MS * 2) / 1000),
  );
  return 'renamed';
}

/**
 * One pass over every server that has a status channel configured.
 *
 * The panel-access set is loaded once per tick rather than per server: it is
 * the same set for all of them and is small (admins only).
 */
export async function runStatusChannelTick(
  deps: StatusChannelDeps,
): Promise<StatusChannelTickSummary> {
  const summary: StatusChannelTickSummary = {
    considered: 0,
    renamed: 0,
    unchanged: 0,
    rateLimited: 0,
    errors: 0,
  };

  const targets = await deps.db
    .select({ id: servers.id, statusChannelId: servers.statusChannelId })
    .from(servers)
    .where(and(isNotNull(servers.statusChannelId), isNull(servers.deletedAt)));
  if (targets.length === 0) return summary;

  const adminSteamIds = await loadPanelAccessSteamIds(deps.db);

  for (const target of targets) {
    const channelId = target.statusChannelId;
    if (!channelId) continue;
    summary.considered++;

    const [statusRaw, rosterRaw] = await Promise.all([
      deps.redis.get(`rcon:status:${target.id}`),
      deps.redis.get(`rcon:roster:${target.id}`),
    ]);
    const snapshot = parseStatusCache(statusRaw);
    const adminCount = countOnlineAdmins(parseRosterCache(rosterRaw), adminSteamIds);
    const name = buildStatusChannelName(snapshot, adminCount);

    const outcome = await renameStatusChannel(deps, channelId, name);
    if (outcome === 'renamed') summary.renamed++;
    else if (outcome === 'unchanged') summary.unchanged++;
    else if (outcome === 'rate_limited') summary.rateLimited++;
    else summary.errors++;
  }

  deps.log.debug({ ...summary }, 'discord status channel tick finished');
  return summary;
}
