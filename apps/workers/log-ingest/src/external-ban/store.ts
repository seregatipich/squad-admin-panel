import {
  alertEvents,
  alertRules,
  type DatabaseClient,
  moderationActions,
  players,
} from '@squad/db';
import {
  type EventEnvelope,
  type ExternalBanMatchedPayload,
  type PlayerConnectedPayload,
  rconCommandRequestSchema,
  rconCommandStream,
} from '@squad/shared-types';
import { and, eq, or } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { persistEventEnvelope } from '../event-store.js';
import { createPlayerWithHistory } from '../player-identity/create-player.js';
import { publish } from '../publish.js';
import type { ExternalBanAction, ExternalBanCache, ExternalBanMatch } from './cache.js';

export const EXTERNAL_BAN_COOLDOWN_SECONDS = 60;
export const EXTERNAL_BAN_SYSTEM_LABEL = 'external-ban-worker';

interface AlertRuleConfig {
  eventKind?: string;
  severity?: 'info' | 'warning' | 'critical';
}

const VALID_ALERT_SEVERITIES = new Set(['info', 'warning', 'critical']);

/** Falls back to 'warning' for a rule's severity that fails the alert_events_severity_chk allowlist. */
function normalizeAlertSeverity(severity: unknown): 'info' | 'warning' | 'critical' {
  return typeof severity === 'string' && VALID_ALERT_SEVERITIES.has(severity)
    ? (severity as 'info' | 'warning' | 'critical')
    : 'warning';
}

function cleanText(value: string | null, max: number): string {
  return (value ?? '')
    .replace(/[\r\n\0]+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Builds a bounded, single-line reason accepted by the RCON AdminKick allowlist. */
export function buildExternalBanKickMessage(sourceName: string, reason: string | null): string {
  const source = cleanText(sourceName, 80);
  const detail = cleanText(reason, 120);
  const suffix = detail ? `: ${detail}` : '';
  return `External ban — ${source}${suffix}`.slice(0, 280);
}

async function resolvePlayer(
  db: DatabaseClient,
  identity: { steamId64: string; eosId: string | null; name: string },
): Promise<string | null> {
  const filters = [eq(players.steamId64, BigInt(identity.steamId64))];
  if (identity.eosId) filters.push(eq(players.eosId, identity.eosId));
  const existing = await db
    .select({ id: players.id })
    .from(players)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const created = await createPlayerWithHistory(db, identity, EXTERNAL_BAN_SYSTEM_LABEL);
  if (created) return created;
  const raced = await db
    .select({ id: players.id })
    .from(players)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(1);
  return raced[0]?.id ?? null;
}

async function enqueueKick(
  redis: Pick<Redis, 'xadd'>,
  serverId: string,
  target: string,
  reason: string,
): Promise<boolean> {
  const request = rconCommandRequestSchema.parse({
    request_id: uuidv7(),
    command: 'AdminKick',
    args: [target, reason],
    actor_player_id: null,
    enqueued_at: new Date().toISOString(),
  });
  try {
    // This is the worker-side equivalent of API sendRconCommandViaWorker:
    // worker packages enqueue to the allowlisted worker-rcon command stream.
    await redis.xadd(
      rconCommandStream(serverId),
      'MAXLEN',
      '~',
      '500',
      '*',
      'request',
      JSON.stringify(request),
    );
    return true;
  } catch {
    return false;
  }
}

async function raiseAuto3Alert(
  db: DatabaseClient,
  redis: Pick<Redis, 'publish'>,
  payload: ExternalBanMatchedPayload,
): Promise<number> {
  const rules = await db
    .select({ id: alertRules.id, config: alertRules.config })
    .from(alertRules)
    .where(and(eq(alertRules.type, 'custom'), eq(alertRules.enabled, true)));
  let raised = 0;
  for (const rule of rules) {
    const config = rule.config as AlertRuleConfig;
    if (config.eventKind !== 'externalban.matched') continue;
    const alertPayload = { ...payload, event_kind: 'externalban.matched' };
    try {
      await db.insert(alertEvents).values({
        id: uuidv7(),
        ruleId: rule.id,
        severity: normalizeAlertSeverity(config.severity),
        payload: alertPayload,
      });
      await redis.publish(
        'live-bus',
        JSON.stringify({
          type: 'alert.triggered',
          ts: new Date().toISOString(),
          data: alertPayload,
        }),
      );
      raised++;
    } catch {
      // A malformed rule config must not abort processing of the remaining
      // external-ban matches for this connect event; skip this rule only.
    }
  }
  return raised;
}

export type ExternalBanConnectOutcome =
  | { outcome: 'ignored' | 'no_match' }
  | { outcome: 'cooldown'; externalBanId: string }
  | {
      outcome: 'handled';
      matches: number;
      kicked: number;
      alerted: number;
      playerId: string | null;
    };

/** Enforces active external bans for one `player.connected` event. */
export async function handleExternalBanConnect(
  db: DatabaseClient,
  redis: Redis,
  cache: ExternalBanCache,
  { serverId, event }: { serverId: string; event: EventEnvelope },
): Promise<ExternalBanConnectOutcome> {
  if (event.type !== 'player.connected') return { outcome: 'ignored' };
  const payload = event.payload as PlayerConnectedPayload;
  const matches = await cache.match(payload.steam_id64, payload.eos_id);
  if (matches.length === 0) return { outcome: 'no_match' };

  const identity = payload.eos_id ?? payload.steam_id64;
  const cooldownKey = (match: ExternalBanMatch) =>
    `externalban:cooldown:${identity}:${match.externalBanId}`;
  const uncooldedMatches: ExternalBanMatch[] = [];
  for (const match of matches) {
    const claimed = await redis.set(
      cooldownKey(match),
      '1',
      'EX',
      EXTERNAL_BAN_COOLDOWN_SECONDS,
      'NX',
    );
    if (claimed) uncooldedMatches.push(match);
  }
  if (uncooldedMatches.length === 0) {
    return { outcome: 'cooldown', externalBanId: matches[0]?.externalBanId ?? '' };
  }

  // A claim only suppresses duplicates of a handled match: when handling fails
  // before the kick is queued, release it so the next connect can retry.
  let playerId: string | null;
  try {
    playerId = await resolvePlayer(db, {
      steamId64: payload.steam_id64,
      eosId: payload.eos_id,
      name: payload.name,
    });
  } catch (err) {
    await Promise.all(uncooldedMatches.map((match) => redis.del(cooldownKey(match))));
    throw err;
  }
  let kicked = 0;
  let alerted = 0;

  for (const match of uncooldedMatches) {
    // Fail closed if a row was written outside the API or an old deployment
    // left a kick action on a non-trusted source.
    const action: ExternalBanAction =
      match.onMatch === 'kick'
        ? match.trustLevel === 'trusted'
          ? 'kick'
          : 'alert'
        : match.onMatch;
    const kickEnqueued =
      action === 'kick'
        ? await enqueueKick(
            redis,
            serverId,
            payload.eos_id ?? payload.steam_id64,
            buildExternalBanKickMessage(match.sourceName, match.reason),
          )
        : false;
    if (action === 'kick' && kickEnqueued) kicked++;
    if (action === 'kick' && !kickEnqueued) await redis.del(cooldownKey(match));

    if (action === 'kick' && playerId) {
      await db.insert(moderationActions).values({
        playerId,
        serverId,
        actionType: 'external_ban_kick',
        authorSystemLabel: EXTERNAL_BAN_SYSTEM_LABEL,
        reason: `${match.sourceName}: ${match.reason ?? 'external ban'}`.slice(0, 1024),
        context: {
          source_id: match.sourceId,
          external_ban_id: match.externalBanId,
          kick_enqueued: kickEnqueued,
        },
      });
    }

    const matchedPayload: ExternalBanMatchedPayload = {
      player_id: playerId,
      source_id: match.sourceId,
      external_ban_id: match.externalBanId,
      steam_id64: payload.steam_id64,
      eos_id: payload.eos_id,
      name: payload.name,
      source_name: match.sourceName,
      reason: match.reason,
      action,
    };
    const matchedEvent: EventEnvelope = {
      event_id: uuidv7(),
      version: 1,
      type: 'externalban.matched',
      server_id: serverId,
      ts: new Date().toISOString(),
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload: matchedPayload,
    };
    await persistEventEnvelope(db, matchedEvent).catch(() => undefined);
    await publish(redis, matchedEvent).catch(() => undefined);
    await redis
      .publish(
        'live-bus',
        JSON.stringify({
          type: 'externalban.matched',
          ts: matchedEvent.ts,
          data: { ...matchedPayload, server_id: serverId, kick_enqueued: kickEnqueued },
        }),
      )
      .catch(() => undefined);
    if (action === 'alert') {
      await raiseAuto3Alert(db, redis, matchedPayload);
      alerted++;
    }
  }

  return { outcome: 'handled', matches: uncooldedMatches.length, kicked, alerted, playerId };
}
