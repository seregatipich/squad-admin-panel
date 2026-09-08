import { v7 as uuidv7 } from 'uuid';

/**
 * SquadJS2 raw event → panel `EventEnvelope`.
 *
 * The envelope shape and every payload key are the RNSquadJS contract
 * (`docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts`) and must not drift:
 * `packages/shared-types/src/events.ts` validates the types and the panel's
 * consumers read these exact keys. What changes here is only where the values
 * are read from — SquadJS2 resolves players into `data.player`/`data.victim`
 * objects and deletes the top-level id fields before emitting (see
 * `ai_docs/squadjs2-pin-2026-08-24.md`).
 */

const MAPPERS = {
  PLAYER_CONNECTED: (r) => ({
    type: 'player.connected',
    payload: {
      steam_id64: r.player?.steamID ?? null,
      eos_id: r.player?.eosID ?? null,
      name: r.player?.name ?? null,
      // The panel contract has never carried the address; SquadJS2 does expose
      // it as `r.ip` should the panel ever want it.
      ip: null,
    },
  }),
  PLAYER_DISCONNECTED: (r) => ({
    type: 'player.disconnected',
    payload: {
      steam_id64: r.player?.steamID ?? null,
      eos_id: r.player?.eosID ?? null,
      reason: null,
    },
  }),
  PLAYER_DAMAGED: (r) => ({
    type: 'player.damaged',
    payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon, damage: r.damage },
  }),
  PLAYER_DIED: (r) => ({
    type: 'player.died',
    payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon },
  }),
  PLAYER_WOUNDED: (r) => ({
    type: 'player.wounded',
    payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon },
  }),
  // SquadJS2 names the revived player `victim`; the panel payload key stays
  // `revived` because consumers and the shadow-diff already read it.
  PLAYER_REVIVED: (r) => ({
    type: 'player.revived',
    payload: { reviver: r.reviver, revived: r.victim },
  }),
  PLAYER_POSSESS: (r) => ({
    type: 'player.possess',
    payload: { player: r.player, vehicle: r.possessClassname },
  }),
  PLAYER_UNPOSSESS: (r) => ({
    type: 'player.unpossess',
    payload: { player: r.player, vehicle: r.possessClassname },
  }),
  // The legacy parser derives these from the match state machine and always
  // emits the same constant transition per event type, so the sidecar mirrors
  // it exactly even though SquadJS2 does not expose the states.
  NEW_GAME: () => ({
    type: 'match.started',
    payload: { from_state: 'WaitingToStart', to_state: 'InProgress' },
  }),
  ROUND_ENDED: () => ({
    type: 'match.ended',
    payload: { from_state: 'InProgress', to_state: 'WaitingPostMatch' },
  }),
  SQUAD_CREATED: (r) => ({
    type: 'squad.created',
    payload: {
      player: r.player,
      squad_id: r.squadID,
      squad_name: r.squadName,
      team: r.teamName,
    },
  }),
  DEPLOYABLE_DAMAGED: (r) => ({
    type: 'deployable.damaged',
    payload: { deployable: r.deployable, damage: r.damage, attacker: r.player },
  }),
  TICK_RATE: (r) => ({
    type: 'server.tick_rate',
    payload: { tick_rate: r.tickRate },
  }),
  ADMIN_BROADCAST: (r) => ({
    type: 'admin.broadcast',
    payload: { message: r.message },
  }),
  CHAT_MESSAGE: (r) => ({
    type: 'chat.message',
    payload: { channel: r.chat, steam_id: r.steamID, name: r.name, message: r.message },
  }),
  POSSESSED_ADMIN_CAMERA: (r) => ({
    type: 'admin.camera_entered',
    payload: { player: r.player },
  }),
  UNPOSSESSED_ADMIN_CAMERA: (r) => ({
    type: 'admin.camera_left',
    payload: { player: r.player },
  }),
};

/** Every SquadJS2 event the panel bridge subscribes to and can map. */
export const MAPPED_EVENTS = Object.freeze(Object.keys(MAPPERS));

function toIsoTimestamp(time) {
  if (typeof time === 'string' || time instanceof Date) {
    const ms = new Date(time).getTime();
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Wraps a mapped payload in the panel envelope.
 *
 * @param {string} serverId - Panel server UUID the envelope belongs to.
 * @param {string} type - Panel event type (already mapped).
 * @param {unknown} time - Raw event time; anything unparseable falls back to now.
 * @param {Record<string, unknown>} payload - Mapped payload.
 * @returns {Record<string, unknown>} The panel `EventEnvelope`.
 */
export function buildEnvelope(serverId, type, time, payload) {
  return {
    event_id: uuidv7(),
    version: 1,
    type,
    server_id: serverId,
    ts: toIsoTimestamp(time),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload,
  };
}

/**
 * Maps one raw SquadJS2 event onto the panel envelope.
 *
 * @param {string} serverId - Panel server UUID.
 * @param {string} squadjsType - SquadJS2 event name (e.g. `PLAYER_CONNECTED`).
 * @param {Record<string, unknown>} raw - The event payload SquadJS2 emitted.
 * @returns {Record<string, unknown> | null} Envelope, or null when the event is
 *   outside the panel contract.
 */
export function mapEvent(serverId, squadjsType, raw) {
  const mapper = MAPPERS[squadjsType];
  if (!mapper) return null;
  const mapped = mapper(raw);
  if (!mapped) return null;
  return buildEnvelope(serverId, mapped.type, raw.time, mapped.payload);
}
