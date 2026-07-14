import type { DiscordEventType } from '@squad/db/schema';
import type { DiscordTemplateContext } from '@squad/shared-config';
import type { EventEnvelope, EventType } from '@squad/shared-types';

/**
 * Pure `EventType` (the shared event bus, EVT-1) → `DiscordEventType` (the
 * editable Discord templates, DISCORD-1/3) mapping.
 *
 * Scope note (DISCORD-2 vs. its stated dependencies): the events stream
 * today only carries `EVENT_TYPES` from `@squad/shared-types` — server
 * lifecycle, player connect/disconnect, match state, rcon, bridge and
 * performance events. The Discord event types `ban_issued`, `kick`, `warn`,
 * `unban`, `admin_login`, `player_report`, `drift_detected` and
 * `marked_player_joined` have no producer yet: `moderation_actions` (MOD-2)
 * has zero writers, and the auth-login / SYNC-4 drift-sweep / `!report`
 * chat-command producers this issue's spec references do not exist in the
 * codebase. This table therefore only maps what the event bus emits today;
 * wiring a new producer later is a one-line addition here, nothing else in
 * the worker needs to change.
 */
const EVENT_TYPE_MAP: Partial<Record<EventType, DiscordEventType>> = {
  'server.crashed': 'server_crashed',
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
 * read generically so a future moderation-event payload (MOD-2) that
 * carries player identity is picked up without changing this function;
 * `player_url` is only built once a `player_id` is present in the payload
 * (none currently is), since `{player_name}`/`steam_id64` alone are not
 * enough to build a correct `/players/:id` link.
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

  const reason = readString(payload, 'reason');
  if (reason) context.reason = reason;

  const joinLink = readString(payload, 'join_link');
  if (joinLink) context.join_link = joinLink;

  const playerName = readString(payload, 'name');
  if (playerName) context.player_name = playerName;

  const steamId64 = readString(payload, 'steam_id64');
  if (steamId64) context.steam_id64 = steamId64;

  const eosId = readString(payload, 'eos_id');
  if (eosId) context.eos_id = eosId;

  const playerId = readString(payload, 'player_id');
  if (playerId && panelBaseUrl) context.player_url = `${panelBaseUrl}/players/${playerId}`;

  return context;
}
