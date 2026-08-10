import {
  DISCORD_ROLE_SYNC_MAXLEN,
  DISCORD_ROLE_SYNC_STATUS_KEY,
  DISCORD_ROLE_SYNC_STREAM,
  type DiscordRoleSyncStatus,
  discordRoleSyncStatus,
} from '@squad/shared-types';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';

/**
 * Publishes a role-sync request for `apps/workers/discord` to pick up
 * (DISCORD-5, #152).
 *
 * Deliberately best-effort and never throwing: it runs *after* the role-change
 * transaction has committed, so a Redis blip here must not turn a successful
 * role assignment into a 500. The worker's hourly reconcile tick re-derives
 * every linked player's Discord roles, so a dropped request self-heals within
 * an hour — which is why this does not use the transactional-outbox machinery
 * that `admins-cfg-sync.ts` needs.
 *
 * @param redis  Redis client used for the XADD.
 * @param playerId Player whose Discord roles must be re-derived, or `null` to
 *   request a full reconcile of every linked player.
 * @param reason Short tag recorded on the stream entry for log correlation.
 * @param log Optional logger; a publish failure is logged at `warn`.
 */
export async function publishDiscordRoleSync(
  redis: Redis,
  playerId: string | null,
  reason: string,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    await redis.xadd(
      DISCORD_ROLE_SYNC_STREAM,
      'MAXLEN',
      '~',
      String(DISCORD_ROLE_SYNC_MAXLEN),
      '*',
      'payload',
      JSON.stringify({ player_id: playerId, reason }),
    );
  } catch (err) {
    log?.warn(
      { err: (err as Error).message, playerId, reason },
      'discord role-sync publish failed; the hourly reconcile will pick it up',
    );
  }
}

/**
 * Reads the worker's last role-sync outcome so the settings UI can surface a
 * failure. Returns `null` when the worker has never reported, when Redis is
 * unreachable, or when the stored value no longer matches the schema — the
 * status is a diagnostic, never a reason to fail the request.
 */
export async function readDiscordRoleSyncStatus(
  redis: Redis,
): Promise<DiscordRoleSyncStatus | null> {
  let raw: string | null;
  try {
    raw = await redis.get(DISCORD_ROLE_SYNC_STATUS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = discordRoleSyncStatus.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
