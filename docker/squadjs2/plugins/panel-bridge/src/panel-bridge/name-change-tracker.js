/**
 * Derives `player.name_changed` from SquadJS2's player-list polling.
 *
 * SquadJS2 has no rename event: `UPDATED_PLAYER_INFORMATION` fires after every
 * `ListPlayers` poll with no payload, and the current names live on
 * `server.players`. The tracker diffs consecutive snapshots so the panel's
 * banned-name enforcement (`apps/workers/log-ingest/src/banname/store.ts`,
 * which reads `name`, `eos_id` and `steam_id64`) works on sidecar servers —
 * under RNSquadJS it never fired because the type was never produced.
 *
 * State is bounded by the online player count: a player that leaves the
 * snapshot is dropped, so a rejoin is treated as a first sighting rather than
 * a rename.
 */
export class NameChangeTracker {
  #names = new Map();

  /** Number of players currently remembered. */
  get size() {
    return this.#names.size;
  }

  /**
   * Diffs a player-list snapshot against the previous one.
   *
   * @param {Array<Record<string, unknown>> | undefined} players - `server.players`.
   * @returns {Array<Record<string, unknown>>} One payload per renamed player,
   *   shaped for the `player.name_changed` envelope.
   */
  diff(players) {
    const snapshot = Array.isArray(players) ? players : [];
    const next = new Map();
    const changes = [];

    for (const player of snapshot) {
      const key = identityOf(player);
      if (key === null) continue;

      const name = typeof player.name === 'string' ? player.name : null;
      if (name === null) continue;

      const previous = this.#names.get(key);
      next.set(key, name);
      if (previous === undefined || previous === name) continue;

      changes.push({
        steam_id64: player.steamID ?? null,
        eos_id: player.eosID ?? null,
        name,
        old_name: previous,
        new_name: name,
      });
    }

    this.#names = next;
    return changes;
  }

  /**
   * Drops one player from the tracked snapshot (used on disconnect).
   *
   * @param {Record<string, unknown> | null | undefined} player - Leaving player.
   */
  forget(player) {
    const key = identityOf(player);
    if (key !== null) this.#names.delete(key);
  }
}

function identityOf(player) {
  if (!player || typeof player !== 'object') return null;
  if (typeof player.steamID === 'string' && player.steamID.length > 0) {
    return `steam:${player.steamID}`;
  }
  if (typeof player.eosID === 'string' && player.eosID.length > 0) return `eos:${player.eosID}`;
  return null;
}
