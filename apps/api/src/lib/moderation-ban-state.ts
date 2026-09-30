import type { DatabaseClient } from '@squad/db';
import { sql } from 'drizzle-orm';
import { parseBanLengthToExpiry } from './banlist-publish.js';
import { uuidArrayParam } from './sql-params.js';

/** Whether a player is currently banned through the panel's own ledger. */
export interface ModerationBanState {
  /** At least one `ban` row is neither reverted nor expired. */
  active: boolean;
  /** At least one of those active rows has no expiry at all. */
  permanent: boolean;
}

/**
 * The single "is this player moderation-banned" rule shared by the alt
 * candidate engine and the pre-ban alt warning (#40, findings #1249/#216).
 *
 * Only `action_type = 'ban'` rows count — `unban`, `external_ban_kick`,
 * `ban_source.*` and every other type merely containing "ban" do not. A row
 * stops counting once `reverted_at` is set, and once its expiry passes. The
 * expiry is derived from `context.ban_length` and the row's `created_at`
 * with the same `AdminBan` grammar the banlist publisher and public appeals
 * use, because every ban writer records `ban_length` while only some record
 * `expires_at`.
 *
 * @param db - The database client.
 * @param playerIds - Players to evaluate; players with no ban row are absent
 *   from the result.
 * @param now - Reference time for expiry (default: the current time).
 * @returns Ban state keyed by player id, for players with an active ban only.
 */
export async function loadModerationBanStates(
  db: DatabaseClient,
  playerIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, ModerationBanState>> {
  const states = new Map<string, ModerationBanState>();
  if (playerIds.length === 0) return states;

  const rows = (await db.execute(sql`
    SELECT player_id, context ->> 'ban_length' AS ban_length, created_at
    FROM moderation_actions
    WHERE player_id = ANY(${uuidArrayParam(playerIds)})
      AND action_type = 'ban'
      AND reverted_at IS NULL
  `)) as unknown as Array<{
    player_id: string;
    ban_length: string | null;
    created_at: Date | string;
  }>;

  for (const row of rows) {
    const expiresAt = parseBanLengthToExpiry(row.ban_length, new Date(row.created_at));
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) continue;
    const state = states.get(row.player_id) ?? { active: true, permanent: false };
    if (expiresAt === null) state.permanent = true;
    states.set(row.player_id, state);
  }
  return states;
}
