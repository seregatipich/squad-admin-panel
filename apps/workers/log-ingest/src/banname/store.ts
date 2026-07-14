import {
  auditLog,
  bannedNameRules,
  type DatabaseClient,
  moderationActions,
  playerNameHistory,
  players,
} from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import type { BannedNameAction, BannedNameMatchType } from '@squad/shared-config/banned-names';
import {
  type EventEnvelope,
  type PlayerConnectedPayload,
  rconCommandRequestSchema,
  rconCommandStream,
} from '@squad/shared-types';
import { eq, or, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { persistEventEnvelope } from '../event-store.js';
import { publish } from '../publish.js';
import type { BannedNameRuleCache } from './rules-cache.js';

export const LIVE_BUS_CHANNEL = 'live-bus';

/** No two kicks/alerts for the same identity+rule within this window (kick-loop prevention). */
const COOLDOWN_SECONDS = 60;
/** Rolling window over which repeated kicks of the same player are counted for escalation. */
const ESCALATION_WINDOW_SECONDS = 600;
/** The 4th kick (i.e. count > this) within the window is downgraded to alert-only. */
const ESCALATION_KICK_THRESHOLD = 3;

const KICK_MESSAGE_MAX_CHARS = 280;
const KICK_REASON_MAX_CHARS = 120;

export interface HandleBannedNameConnectParams {
  serverId: string;
  event: EventEnvelope;
}

export type BannedNameConnectOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'no_match' }
  | { outcome: 'cooldown'; ruleId: string }
  | {
      outcome: 'handled';
      playerId: string | null;
      ruleId: string;
      matchType: BannedNameMatchType;
      ruleAction: BannedNameAction;
      effectiveAction: BannedNameAction;
      escalated: boolean;
      kickEnqueued: boolean;
    };

function sanitizeReasonText(reason: string | null): string {
  if (!reason) return '';
  return reason
    .replace(/[\r\n\0]+/g, ' ')
    .trim()
    .slice(0, KICK_REASON_MAX_CHARS);
}

/**
 * RU+EN kick message shown to the player, interpolating the rule's reason.
 * This lives as a module constant rather than a configurable template: the
 * panel has no settings KV store to hang admin-editable copy on (a scope
 * narrowing from the BANNAME-2 issue text, called out in the PR report).
 */
export function buildBannedNameKickMessage(reason: string | null): string {
  const clean = sanitizeReasonText(reason);
  const ru = clean ? `Вы кикнуты: запрещённый ник (${clean})` : 'Вы кикнуты: запрещённый ник';
  const en = clean ? `Kicked: banned nickname (${clean})` : 'Kicked: banned nickname';
  return `${ru} / ${en}`.slice(0, KICK_MESSAGE_MAX_CHARS);
}

async function resolveByIdentity(
  db: DatabaseClient,
  identity: { eosId: string | null; steamId64: string | null },
): Promise<{ id: string } | null> {
  const filters = [];
  if (identity.eosId) filters.push(eq(players.eosId, identity.eosId));
  if (identity.steamId64) filters.push(eq(players.steamId64, BigInt(identity.steamId64)));
  if (filters.length === 0) return null;
  const rows = await db
    .select({ id: players.id })
    .from(players)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(1);
  return rows[0] ?? null;
}

async function createPlayer(
  db: DatabaseClient,
  identity: { eosId: string | null; steamId64: string | null; name: string },
): Promise<string | null> {
  const normalized = normalizePlayerName(identity.name);
  const playerId = uuidv7();
  try {
    await db.insert(players).values({
      id: playerId,
      steamId64: identity.steamId64 ? BigInt(identity.steamId64) : null,
      eosId: identity.eosId,
      canonicalName: identity.name,
      canonicalNameNormalized: normalized,
    });
    await db.insert(playerNameHistory).values({
      playerId,
      name: identity.name,
      nameNormalized: normalized,
    });
    await db.insert(auditLog).values({
      actorKind: 'system',
      actorSystemLabel: 'banname-worker',
      actionType: 'player.created',
      targetType: 'player',
      targetId: playerId,
      context: {
        eos_id: identity.eosId,
        steam_id64: identity.steamId64,
        canonical_name: identity.name,
      },
      rowHash: Buffer.from([]),
    });
    return playerId;
  } catch {
    const existing = await resolveByIdentity(db, {
      eosId: identity.eosId,
      steamId64: identity.steamId64,
    });
    return existing?.id ?? null;
  }
}

async function resolveOrCreatePlayer(
  db: DatabaseClient,
  identity: { eosId: string | null; steamId64: string | null; name: string },
): Promise<string | null> {
  const existing = await resolveByIdentity(db, {
    eosId: identity.eosId,
    steamId64: identity.steamId64,
  });
  if (existing) return existing.id;
  return createPlayer(db, identity);
}

/**
 * BANNAME-2 enforcement: on `player.connected`, matches the joining nickname
 * against the cached active `banned_name_rules` and, on a hit, kicks (via
 * worker-rcon) or alerts, records the moderation ledger entry, and emits a
 * `banname.matched` event + live-bus frame. See the issue for the full
 * anti-loop cooldown/escalation contract.
 */
export async function handleBannedNameConnect(
  db: DatabaseClient,
  redis: Redis,
  { serverId, event }: HandleBannedNameConnectParams,
  cache: BannedNameRuleCache,
): Promise<BannedNameConnectOutcome> {
  if (event.type !== 'player.connected') return { outcome: 'ignored' };
  const payload = event.payload as PlayerConnectedPayload;

  const match = await cache.match(payload.name);
  if (!match) return { outcome: 'no_match' };

  // Keyed by the connect event's own identity (not the resolved player row)
  // so the cooldown gate never needs a DB roundtrip before it can bail.
  const identity = payload.eos_id ?? payload.steam_id64;
  const cooldownKey = `banname:cooldown:${identity}:${match.ruleId}`;
  const claimed = await redis.set(cooldownKey, '1', 'EX', COOLDOWN_SECONDS, 'NX');
  if (!claimed) return { outcome: 'cooldown', ruleId: match.ruleId };

  const playerId = await resolveOrCreatePlayer(db, {
    eosId: payload.eos_id,
    steamId64: payload.steam_id64,
    name: payload.name,
  });

  let effectiveAction: BannedNameAction = match.action;
  let escalated = false;
  if (match.action === 'kick') {
    const kicksKey = `banname:kicks:${identity}`;
    const kicksCount = await redis.incr(kicksKey);
    if (kicksCount === 1) await redis.expire(kicksKey, ESCALATION_WINDOW_SECONDS);
    if (kicksCount > ESCALATION_KICK_THRESHOLD) {
      effectiveAction = 'alert';
      escalated = true;
    }
  }

  let kickEnqueued = false;
  if (effectiveAction === 'kick') {
    const target = payload.eos_id ?? payload.steam_id64;
    const request = rconCommandRequestSchema.parse({
      request_id: uuidv7(),
      command: 'AdminKick',
      args: [target, buildBannedNameKickMessage(match.reason)],
      actor_player_id: null,
      enqueued_at: new Date().toISOString(),
    });
    try {
      await redis.xadd(
        rconCommandStream(serverId),
        'MAXLEN',
        '~',
        '500',
        '*',
        'request',
        JSON.stringify(request),
      );
      kickEnqueued = true;
    } catch {
      kickEnqueued = false;
    }
  }

  if (playerId) {
    await db.insert(moderationActions).values({
      playerId,
      serverId,
      actionType: 'name_kick',
      authorSystemLabel: 'banname-worker',
      reason: match.reason,
      context: {
        rule_id: match.ruleId,
        nickname: payload.name,
        match_type: match.matchType,
        action: effectiveAction,
        escalated,
        kick_enqueued: kickEnqueued,
      },
    });
  }

  await db
    .update(bannedNameRules)
    .set({ hitCount: sql`${bannedNameRules.hitCount} + 1`, lastHitAt: new Date() })
    .where(eq(bannedNameRules.id, match.ruleId));

  const matchedEvent: EventEnvelope = {
    event_id: uuidv7(),
    version: 1,
    type: 'banname.matched',
    server_id: serverId,
    ts: new Date().toISOString(),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: {
      player_id: playerId,
      rule_id: match.ruleId,
      nickname: payload.name,
      action: effectiveAction,
      escalated,
    },
  };
  await persistEventEnvelope(db, matchedEvent).catch(() => undefined);
  await publish(redis, matchedEvent).catch(() => undefined);
  await redis
    .publish(
      LIVE_BUS_CHANNEL,
      JSON.stringify({
        type: 'banname.matched',
        ts: matchedEvent.ts,
        data: {
          playerId,
          ruleId: match.ruleId,
          nickname: payload.name,
          action: effectiveAction,
          escalated,
          serverId,
        },
      }),
    )
    .catch(() => undefined);

  return {
    outcome: 'handled',
    playerId,
    ruleId: match.ruleId,
    matchType: match.matchType,
    ruleAction: match.action,
    effectiveAction,
    escalated,
    kickEnqueued,
  };
}
