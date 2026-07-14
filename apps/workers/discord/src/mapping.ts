import type { DiscordEventType } from '@squad/db/schema';
import type { DiscordTemplateContext } from '@squad/shared-config';
import type { EventEnvelope, EventType } from '@squad/shared-types';

/**
 * Pure `EventType` (the shared event bus, EVT-1) → `DiscordEventType` (the
 * editable Discord templates, DISCORD-1/3) mapping.
 *
 * Moderation actions and in-game reports have durable producers. The
 * `admin_login`, `drift_detected`, and `marked_player_joined` Discord types
 * remain intentionally unmapped until their producers publish a typed EVT-1
 * envelope rather than a live-bus or diagnostics-only record.
 */
const EVENT_TYPE_MAP: Partial<Record<EventType, DiscordEventType>> = {
  'server.crashed': 'server_crashed',
  'moderation.ban': 'ban_issued',
  'moderation.kick': 'kick',
  'moderation.warn': 'warn',
  'moderation.unban': 'unban',
  player_report: 'player_report',
  'server.seeding_started': 'seed_needed',
  'seed.call_sent': 'seed_needed',
  'match.ended': 'match_ended',
  'match.started': 'map_changed',
};

/** Maps a shared-bus event type to its Discord notification type, or `null` if none is configured. */
export function mapEventToDiscordType(type: EventType): DiscordEventType | null {
  return EVENT_TYPE_MAP[type] ?? null;
}

export interface TemplateContextInput {
  envelope: EventEnvelope;
  /** Resolved `servers.display_name` for `envelope.server_id`, or `null`. */
  serverName: string | null;
  /** Base URL used to build `{player_url}` links, or `null` to omit them. */
  panelBaseUrl: string | null;
}

function readString(payload: unknown, key: string): string | undefined {
  if (payload == null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Builds the `{token}` substitution context for `renderDiscordTemplate` out
 * of an envelope's typed payload. Only fields the payload actually carries
 * are set — an omitted key renders as an empty string (never throws) per
 * `renderDiscordTemplate`'s contract. `player_name`/`steam_id64`/`eos_id` are
 * read generically from moderation/report payloads. `player_url` is only
 * built once a player UUID is present, since `{player_name}`/`steam_id64`
 * alone are not enough to build a correct `/players/:id` link.
 */
export function buildTemplateContext({
  envelope,
  serverName,
  panelBaseUrl,
}: TemplateContextInput): DiscordTemplateContext {
  const context: DiscordTemplateContext = {};
  if (serverName) context.server_name = serverName;

  const { payload } = envelope;
  const layer = readString(payload, 'layer') ?? readString(payload, 'seed_layer');
  if (layer) context.map = layer;

  const reason = readString(payload, 'reason') ?? readString(payload, 'body');
  if (reason) context.reason = reason;

  const duration = readString(payload, 'duration');
  if (duration) context.duration = duration;

  const actorName = readString(payload, 'actor_name') ?? readString(payload, 'reporter_name');
  if (actorName) context.actor_name = actorName;

  const joinLink = readString(payload, 'join_link');
  if (joinLink) context.join_link = joinLink;

  const playerName = readString(payload, 'name') ?? readString(payload, 'target_raw');
  if (playerName) context.player_name = playerName;

  const steamId64 = readString(payload, 'steam_id64');
  if (steamId64) context.steam_id64 = steamId64;

  const eosId = readString(payload, 'eos_id');
  if (eosId) context.eos_id = eosId;

  const playerId = readString(payload, 'player_id') ?? readString(payload, 'target_player_id');
  if (playerId && panelBaseUrl) context.player_url = `${panelBaseUrl}/players/${playerId}`;

  return context;
}
