import { events, moderationActions } from '@squad/db/schema';
import {
  type EventEnvelope,
  type EventType,
  moderationActionPayload,
  STREAM_NAME,
} from '@squad/shared-types';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { parseBanLengthToExpiry } from './banlist-publish.js';
import { sendRconCommandViaWorker, type WorkerRconCommandOutcome } from './rcon-worker-command.js';

/**
 * Shared RCON -> ledger -> EVT-1 enforcement pipeline for the panel's
 * moderation surfaces (MOD-2, #59). Extracted from the ban/kick/warn
 * enforcement inlined in `external-bans.ts`'s local-ban route so the
 * player-card action route (this task), the live-players action route
 * (#61), and the report action route (#62) share one implementation.
 *
 * This module's exported surface is a frozen contract: #61 and #62 import it
 * directly, so signatures here must not change once this task merges.
 */

export type EnforceActionType = 'warn' | 'kick' | 'ban';
export type ModerationActionSource = 'player_card' | 'live_players' | 'report' | 'external_ban';

/** The subset of a player's identity RCON commands and EVT-1 payloads need. */
export interface PlayerIdentity {
  eosId: string | null;
  steamId64: string | null;
  name: string;
}

export interface EnforceModerationActionInput {
  serverId: string;
  playerId: string;
  identity: PlayerIdentity;
  actionType: EnforceActionType;
  reason: string;
  banLength: string;
  actorPlayerId: string;
  actorName: string;
  reportId?: string | null;
  source?: ModerationActionSource;
  /** Extra `context` jsonb keys the caller wants recorded (e.g. `external_ban_id`). */
  extraContext?: Record<string, unknown>;
}

export type EnforceModerationActionResult =
  | { ok: false; outcome: WorkerRconCommandOutcome }
  | {
      ok: true;
      actionId: string;
      requestId: string;
      envelope: EventEnvelope;
      context: Record<string, unknown>;
    };

const RCON_COMMAND_BY_ACTION: Record<EnforceActionType, 'AdminWarn' | 'AdminKick' | 'AdminBan'> = {
  warn: 'AdminWarn',
  kick: 'AdminKick',
  ban: 'AdminBan',
};

const MODERATION_EVENT_TYPE: Record<'ban' | 'kick' | 'warn' | 'unban', EventType> = {
  ban: 'moderation.ban',
  kick: 'moderation.kick',
  warn: 'moderation.warn',
  unban: 'moderation.unban',
};

/**
 * Enforces a warn/kick/ban through worker-rcon and, only once the command is
 * confirmed applied, records the `moderation_actions` ledger row and
 * publishes the EVT-1 envelope consumed by discord-notify. A failed or
 * timed-out RCON command never leaves a ledger row behind — the caller gets
 * `{ ok: false, outcome }` and nothing is persisted.
 *
 * @param app - The Fastify instance (`app.db`, `app.redis`).
 * @param input - The action to enforce. `input.identity` must resolve a
 *   target (`eosId` or `steamId64`) — this is a caller precondition, not a
 *   recoverable outcome, and violating it throws.
 * @returns `{ ok: false, outcome }` when the RCON command was not
 *   attempted or was rejected/timed out; `{ ok: true, actionId, requestId,
 *   envelope, context }` once enforcement is confirmed and persisted.
 */
export async function enforceModerationAction(
  app: FastifyInstance,
  input: EnforceModerationActionInput,
): Promise<EnforceModerationActionResult> {
  const target = input.identity.eosId ?? input.identity.steamId64;
  if (!target) {
    throw new Error('enforceModerationAction: identity has neither eosId nor steamId64');
  }

  const command = RCON_COMMAND_BY_ACTION[input.actionType];
  const args =
    input.actionType === 'ban' ? [target, input.banLength, input.reason] : [target, input.reason];

  const outcome = await sendRconCommandViaWorker(app.redis, {
    serverId: input.serverId,
    command,
    args,
    actorPlayerId: input.actorPlayerId,
  });
  if (!outcome.attempted || !outcome.ok) {
    return { ok: false, outcome };
  }

  const expiresAt = parseBanLengthToExpiry(input.banLength, new Date());
  const context: Record<string, unknown> = {
    ban_length: input.banLength,
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    rcon_request_id: outcome.requestId,
    target,
    source: input.source ?? 'player_card',
    ...input.extraContext,
  };

  const [action] = await app.db
    .insert(moderationActions)
    .values({
      playerId: input.playerId,
      serverId: input.serverId,
      actionType: input.actionType,
      authorPlayerId: input.actorPlayerId,
      reason: input.reason,
      context,
      reportId: input.reportId ?? null,
    })
    .returning({ id: moderationActions.id });
  if (!action) throw new Error('moderation action insert returned no row');

  const envelope = await publishModerationEvent(app, {
    actionId: action.id,
    actionType: input.actionType,
    actorPlayerId: input.actorPlayerId,
    actorName: input.actorName,
    playerId: input.playerId,
    player: input.identity,
    serverId: input.serverId,
    reportId: input.reportId ?? null,
    reason: input.reason,
    duration: input.actionType === 'ban' ? input.banLength : null,
  });

  return { ok: true, actionId: action.id, requestId: outcome.requestId, envelope, context };
}

/**
 * Marks every currently-active `ban`-type ledger row for `playerId`+
 * `serverId` as reverted. Squad appends a fresh `Banned:` line on each
 * `AdminBan` rather than replacing one, so a player can accumulate more than
 * one active ban row; an unban must clear all of them, not just the row the
 * operator clicked through, to match the row set actually removed from
 * `Bans.cfg` by {@link removeBanLines}.
 *
 * `targetActionId` — the specific row the revert was invoked from — is
 * always included in the update, even if a concurrent request already
 * reverted it, so calling this twice for the same target action is
 * idempotent from the caller's perspective.
 *
 * @returns The ids of every row that was (re-)marked reverted.
 */
export async function markBansReverted(
  app: FastifyInstance,
  params: { playerId: string; serverId: string; actorPlayerId: string; targetActionId: string },
): Promise<string[]> {
  const rows = await app.db
    .update(moderationActions)
    .set({ revertedAt: new Date(), revertedBy: params.actorPlayerId })
    .where(
      and(
        eq(moderationActions.playerId, params.playerId),
        eq(moderationActions.serverId, params.serverId),
        eq(moderationActions.actionType, 'ban'),
        or(isNull(moderationActions.revertedAt), eq(moderationActions.id, params.targetActionId)),
      ),
    )
    .returning({ id: moderationActions.id });
  return rows.map((row) => row.id);
}

/**
 * Persists a `moderation.<action_type>` row in the `events` ledger and
 * publishes its EVT-1 envelope onto the per-server Redis stream consumed by
 * discord-notify (DISCORD-2).
 */
export async function publishModerationEvent(
  app: FastifyInstance,
  params: {
    actionId: string;
    actionType: 'ban' | 'kick' | 'warn' | 'unban';
    actorPlayerId: string;
    actorName: string;
    playerId: string;
    player: PlayerIdentity;
    serverId: string;
    reportId: string | null;
    reason: string;
    duration: string | null;
  },
): Promise<EventEnvelope> {
  const payload = moderationActionPayload.parse({
    moderation_action_id: params.actionId,
    action_type: params.actionType,
    player_id: params.playerId,
    steam_id64: params.player.steamId64,
    eos_id: params.player.eosId,
    name: params.player.name,
    reason: params.reason,
    duration: params.duration,
    actor_name: params.actorName,
    report_id: params.reportId,
  });
  const envelope: EventEnvelope = {
    event_id: uuidv7(),
    version: 1,
    type: MODERATION_EVENT_TYPE[params.actionType],
    server_id: params.serverId,
    ts: new Date().toISOString(),
    actor: { kind: 'user', id: params.actorPlayerId },
    correlation_id: params.reportId,
    payload,
  };

  await app.db.insert(events).values({
    eventId: envelope.event_id,
    serverId: envelope.server_id,
    occurredAt: new Date(envelope.ts),
    kind: envelope.type,
    version: envelope.version,
    actorKind: envelope.actor?.kind ?? null,
    actorId: envelope.actor?.id ?? null,
    correlationId: envelope.correlation_id,
    payload: envelope.payload,
  });
  await app.redis.xadd(
    STREAM_NAME.eventsServer(params.serverId),
    'MAXLEN',
    '~',
    '10000',
    '*',
    'envelope',
    JSON.stringify(envelope),
  );
  return envelope;
}
