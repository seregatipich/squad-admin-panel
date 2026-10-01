import type { RconSquad } from '../parse-list-squads.js';
import type { RosterEntry } from '../roster.js';
import type { SupervisorOptions, Target } from './types.js';

/**
 * The `rcon:status` fields the panel renders. `rcon:status:changed` is
 * published only when one of these (or the state) changes, so a refresh every
 * few seconds does not make every open panel re-fetch its server list.
 * Tickrate and timestamps are deliberately left out: they move on every read.
 */
const PUBLISHED_STATUS_FIELDS = [
  'player_count',
  'squad_count',
  'current_map',
  'next_level',
  'next_layer',
  'game_mode',
  'public_queue',
] as const;

type ConnectedStatus = Partial<
  Record<(typeof PUBLISHED_STATUS_FIELDS)[number] | 'last_poll_at' | 'tickrate_rt', unknown>
>;

/**
 * Publishes one server's `rcon:status`, `rcon:roster` and `rcon:squads` cache
 * keys and the live-bus events that announce them. It owns the last-published
 * signatures, so a refresh that changed nothing the panel renders stays silent.
 */
export class StatusPublisher {
  /**
   * Last known connected-state fields. The roster, info and full-poll paths
   * each refresh a slice of them; every status write carries the whole set so
   * a fast roster write never blanks the map the info refresh read.
   */
  private connectedStatus: ConnectedStatus = {};
  /** Signature of the last `rcon:status:changed` publish; see {@link PUBLISHED_STATUS_FIELDS}. */
  private lastPublishedStatus: string | null = null;
  /** Signature of the last `rcon.roster` composition actually published; see {@link writeRoster}. */
  private lastPublishedRoster: string | null = null;

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {}

  /**
   * Writes `rcon:status:{id}`. For `connected`, `extra` is a patch merged into
   * the fields earlier refreshes already read (undefined values keep the old
   * one), so each refresh path only has to supply what it re-read. Any other
   * state starts the connected fields over. `rcon:status:changed` goes out on
   * every non-connected write, and on a connected write only when a field the
   * panel renders actually changed.
   */
  async writeStatus(
    state: 'connected' | 'disconnected' | 'connecting',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    let body: Record<string, unknown> = extra;
    let signature: string | null = null;
    if (state === 'connected') {
      for (const [field, value] of Object.entries(extra)) {
        if (value !== undefined) (this.connectedStatus as Record<string, unknown>)[field] = value;
      }
      body = { ...this.connectedStatus };
      signature = JSON.stringify(
        PUBLISHED_STATUS_FIELDS.map((field) => this.connectedStatus[field] ?? null),
      );
    } else {
      this.connectedStatus = {};
    }
    const key = `rcon:status:${this.target.serverId}`;
    const value = JSON.stringify({ state, ts: new Date().toISOString(), ...body });
    try {
      // 5-minute TTL; a worker crash or network cut removes the stale key.
      await this.opts.redis.set(key, value, 'EX', 300);
    } catch {
      // telemetry only; swallow
    }
    if (signature !== null && signature === this.lastPublishedStatus) return;
    this.lastPublishedStatus = null;
    try {
      const playerCount =
        typeof body.player_count === 'number' ? (body.player_count as number) : undefined;
      await this.opts.redis.publish(
        'rcon:status:changed',
        JSON.stringify({
          server_id: this.target.serverId,
          state,
          ...(playerCount !== undefined ? { player_count: playerCount } : {}),
        }),
      );
      // Remembered only once delivered, so a failed publish is retried by the
      // next write even when nothing changed in between.
      this.lastPublishedStatus = signature;
    } catch {
      // best-effort fan-out; the SET above is the source of truth
    }
  }

  async writeRoster(entries: RosterEntry[], polledAt: string): Promise<void> {
    const key = `rcon:roster:${this.target.serverId}`;
    try {
      await this.opts.redis.set(
        key,
        JSON.stringify({ server_id: this.target.serverId, polled_at: polledAt, players: entries }),
        'EX',
        90,
      );
    } catch {
      // roster cache is telemetry; the live event below still fans out
    }
    // `scheduleRosterRefresh` calls this on every tick (every
    // rosterIntervalMs, default 2s) even when nobody joined, left, or moved
    // squads. Publishing unconditionally turned every open server page into
    // an effectively-2s poll dressed up as an event: each `rcon.roster`
    // fires a full GET /roster (Postgres join) on the client. Compare a
    // signature of the fields the roster view actually renders and skip the
    // publish when nothing changed — mirrors `writeStatus`'s
    // `lastPublishedStatus` guard above.
    const signature = JSON.stringify(
      entries
        .map((e) => [e.rcon_id, e.eos_id, e.name, e.team_id, e.squad_id, e.is_leader, e.role])
        .sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
    if (signature === this.lastPublishedRoster) return;
    this.lastPublishedRoster = null;
    try {
      await this.opts.redis.publish(
        'live-bus',
        JSON.stringify({
          type: 'rcon.roster',
          ts: polledAt,
          data: {
            server_id: this.target.serverId,
            player_count: entries.length,
            polled_at: polledAt,
          },
        }),
      );
      // Remembered only once delivered, so a failed publish is retried by
      // the next tick even when the composition didn't change again.
      this.lastPublishedRoster = signature;
    } catch {
      // best-effort fan-out; the SET above is the source of truth
    }
  }

  async writeSquads(squads: RconSquad[], polledAt: string): Promise<void> {
    const key = `rcon:squads:${this.target.serverId}`;
    try {
      await this.opts.redis.set(
        key,
        JSON.stringify({ server_id: this.target.serverId, polled_at: polledAt, squads }),
        'EX',
        90,
      );
    } catch {
      // squad cache is telemetry; it must not derail player identity polling
    }
  }
}
