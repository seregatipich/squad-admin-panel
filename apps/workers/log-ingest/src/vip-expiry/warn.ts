import { type DatabaseClient, economySettings, expiryNotifications, players } from '@squad/db';
import type { EventEnvelope, PlayerConnectedPayload } from '@squad/shared-types';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { type RconEnqueue, sendRconCommand } from '../chat/commands.js';

export type VipExpiryWarnOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'player_not_found' }
  | { outcome: 'no_pending' }
  | { outcome: 'warn_disabled'; stamped: number }
  | { outcome: 'warned'; windowDays: number; stamped: number };

async function findConnectingPlayerId(
  db: DatabaseClient,
  payload: PlayerConnectedPayload,
): Promise<string | null> {
  const steamIdentity = eq(players.steamId64, BigInt(payload.steam_id64));
  const identity = payload.eos_id
    ? or(steamIdentity, eq(players.eosId, payload.eos_id))
    : steamIdentity;
  const rows = await db.select({ id: players.id }).from(players).where(identity).limit(1);
  return rows[0]?.id ?? null;
}

async function isWarnInGameEnabled(db: DatabaseClient): Promise<boolean> {
  const rows = await db
    .select({ enabled: economySettings.vipExpiryWarnInGame })
    .from(economySettings)
    .where(eq(economySettings.id, 1))
    .limit(1);
  return rows[0]?.enabled ?? true;
}

/**
 * VIPSUB-4 (#170): delivers the one-shot in-game VIP expiry warning. On
 * `player.connected`, any pending `expiry_notifications` rows for the player
 * (recipient `player`, `queued_at IS NULL`) produce a single `AdminWarn`
 * — «VIP истекает через N дн.» with the most urgent (smallest) pending window
 * — and every pending row is stamped `queued_at` so the next connect does not
 * re-warn. With `vip_expiry_warn_in_game=false` nothing is sent, but the rows
 * are still stamped to avoid an infinite pending queue.
 */
export async function handleVipExpiryWarnConnect(
  db: DatabaseClient,
  redis: RconEnqueue,
  { serverId, event }: { serverId: string; event: EventEnvelope },
): Promise<VipExpiryWarnOutcome> {
  if (event.type !== 'player.connected') return { outcome: 'ignored' };
  const payload = event.payload as PlayerConnectedPayload;
  const playerId = await findConnectingPlayerId(db, payload);
  if (!playerId) return { outcome: 'player_not_found' };

  const pending = await db
    .select({ id: expiryNotifications.id, windowDays: expiryNotifications.windowDays })
    .from(expiryNotifications)
    .where(
      and(
        eq(expiryNotifications.playerId, playerId),
        eq(expiryNotifications.recipient, 'player'),
        isNull(expiryNotifications.queuedAt),
      ),
    )
    .orderBy(asc(expiryNotifications.windowDays));
  if (pending.length === 0) return { outcome: 'no_pending' };

  const windowDays = (pending[0] as { windowDays: number }).windowDays;
  const enabled = await isWarnInGameEnabled(db);
  if (enabled) {
    await sendRconCommand(redis, {
      serverId,
      command: 'AdminWarn',
      args: [payload.eos_id ?? payload.steam_id64, `VIP истекает через ${windowDays} дн.`],
    });
  }

  await db
    .update(expiryNotifications)
    .set({ queuedAt: new Date() })
    .where(
      inArray(
        expiryNotifications.id,
        pending.map((row) => row.id),
      ),
    );

  return enabled
    ? { outcome: 'warned', windowDays, stamped: pending.length }
    : { outcome: 'warn_disabled', stamped: pending.length };
}
