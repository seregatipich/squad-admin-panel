/** Redis stream cap; the panel's own consumers trim nothing themselves. */
const STREAM_MAXLEN = '10000';

/** Sidecar status TTL in seconds, matching the RNSquadJS bridge. */
const STATUS_TTL_SECONDS = 300;

/**
 * Types the sidecar may publish onto the live stream.
 *
 * In production mode the sidecar replaces only the legacy log pipeline (D4),
 * and the panel's strict envelope schema rejects types outside its enum — so
 * the real stream receives the legacy-parity types only. `player.name_changed`
 * joins the set with SquadJS2: it is derived from player-list polling and
 * unblocks banned-name enforcement on sidecar servers. Shadow mode publishes
 * everything for parity analysis.
 */
export const PRODUCTION_TYPES = new Set([
  'player.connected',
  'player.disconnected',
  'player.name_changed',
  'match.started',
  'match.ended',
]);

/** Publishes panel envelopes and sidecar status into Redis. */
export class RedisPublisher {
  /**
   * @param {import('ioredis').Redis} redis - Connected client.
   * @param {string} serverId - Panel server UUID.
   * @param {'production' | 'shadow'} mode - Which key namespace to write.
   */
  constructor(redis, serverId, mode) {
    this.redis = redis;
    this.serverId = serverId;
    this.mode = mode;
  }

  #suffix() {
    return this.mode === 'shadow' ? ':shadow' : '';
  }

  #eventStream() {
    return `events:server:${this.serverId}${this.#suffix()}`;
  }

  #statusKey() {
    // D4: worker-rcon owns `rcon:status:{id}`; the sidecar publishes under its
    // own engine-neutral prefix and must never clobber the worker's key.
    return `sidecar:status:${this.serverId}${this.#suffix()}`;
  }

  /**
   * Appends one envelope to the server's event stream.
   *
   * Production mode drops types outside {@link PRODUCTION_TYPES} before the
   * write, so the live stream never carries anything the panel schema rejects.
   *
   * @param {Record<string, unknown>} envelope - Panel `EventEnvelope`.
   */
  async publishEvent(envelope) {
    if (this.mode === 'production' && !PRODUCTION_TYPES.has(envelope.type)) return;
    await this.redis.xadd(
      this.#eventStream(),
      'MAXLEN',
      '~',
      STREAM_MAXLEN,
      '*',
      'envelope',
      JSON.stringify(envelope),
    );
  }

  /**
   * Publishes the sidecar's view of its RCON connection.
   *
   * @param {{ state: 'connected' | 'disconnected', lastChange: string }} status - Current state.
   */
  async publishRconStatus(status) {
    await this.redis.set(this.#statusKey(), JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);
  }
}
