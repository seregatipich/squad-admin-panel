import {
  type DatabaseClient,
  findConfirmedAltLinks,
  moderationActions,
  players,
  raiseAltBanAlert,
} from '@squad/db';
import type {
  AltBanEvasionSuspectedPayload,
  EventEnvelope,
  PlayerConnectedPayload,
} from '@squad/shared-types';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { persistEventEnvelope } from '../event-store.js';
import { publish } from '../publish.js';

export type AltBanConnectOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'player_not_found' }
  | { outcome: 'no_confirmed_alt'; connectingPlayerId: string }
  | { outcome: 'no_active_ban'; connectingPlayerId: string }
  | {
      outcome: 'detected';
      connectingPlayerId: string;
      bannedPlayerIds: string[];
      alertsRaised: number;
      signalEventId: string;
    };

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

/**
 * Detects a confirmed alt joining while a linked account has an unreverted
 * local ban, persists the ALT-7 domain event, and raises configured AUTO-3
 * alerts through the shared emitter.
 */
export async function handleAltBanConnect(
  db: DatabaseClient,
  redis: Redis,
  event: EventEnvelope,
): Promise<AltBanConnectOutcome> {
  if (event.type !== 'player.connected') return { outcome: 'ignored' };
  const payload = event.payload as PlayerConnectedPayload;
  const connectingPlayerId = await findConnectingPlayerId(db, payload);
  if (!connectingPlayerId) return { outcome: 'player_not_found' };

  const confirmedLinks = await findConfirmedAltLinks(db, connectingPlayerId);
  if (confirmedLinks.length === 0) {
    return { outcome: 'no_confirmed_alt', connectingPlayerId };
  }

  const linkedPlayerIds = confirmedLinks.map((link) => link.linkedPlayerId);
  const activeBans = await db
    .select({ playerId: moderationActions.playerId })
    .from(moderationActions)
    .where(
      and(
        inArray(moderationActions.playerId, linkedPlayerIds),
        eq(moderationActions.actionType, 'ban'),
        isNull(moderationActions.revertedAt),
      ),
    );
  const bannedPlayerIds = Array.from(new Set(activeBans.map((ban) => ban.playerId)));
  if (bannedPlayerIds.length === 0) {
    return { outcome: 'no_active_ban', connectingPlayerId };
  }

  const signalEventId = uuidv7();
  const signalPayload: AltBanEvasionSuspectedPayload = {
    target_player_id: connectingPlayerId,
    confirmed_alt_ids: bannedPlayerIds,
    candidate_ids: [],
    trigger: 'player_connected',
    server_id: event.server_id,
    connection_event_id: event.event_id,
  };
  const signalEvent: EventEnvelope = {
    event_id: signalEventId,
    version: 1,
    type: 'alt.ban_evasion_suspected',
    server_id: event.server_id,
    ts: event.ts,
    actor: { kind: 'system', id: null },
    correlation_id: event.event_id,
    payload: signalPayload,
  };
  await persistEventEnvelope(db, signalEvent);
  await publish(redis, signalEvent);
  const alertsRaised = await raiseAltBanAlert(db, redis, signalPayload);

  return {
    outcome: 'detected',
    connectingPlayerId,
    bannedPlayerIds,
    alertsRaised,
    signalEventId,
  };
}
