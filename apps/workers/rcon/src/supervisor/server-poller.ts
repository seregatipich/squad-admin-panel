import type { RconRefreshScope } from '@squad/shared-config';
import type { RconClient } from '../client.js';
import { parseListPlayers, type RconPlayer } from '../parse-list-players.js';
import { parseListSquads } from '../parse-list-squads.js';
import { parseServerInfo } from '../parse-server-info.js';
import { parseShowNextMap } from '../parse-show-next-map.js';
import {
  accruePlayerKitTime,
  closeServerSessions,
  reconcilePlayerSessions,
  upsertPlayers,
} from '../persist.js';
import { buildRoster } from '../roster.js';
import { A2sProbe } from './a2s-probe.js';
import { AdminCommandQueue } from './admin-command-queue.js';
import { SeedingTracker } from './seeding-tracker.js';
import { ServerEvents } from './server-events.js';
import { SquadHistory } from './squad-history.js';
import { StatusPublisher } from './status-publisher.js';
import type { SupervisorOptions, Target } from './types.js';

/** Default cadence of the light roster refresh; see {@link SupervisorOptions.rosterIntervalMs}. */
export const DEFAULT_ROSTER_INTERVAL_MS = 2_000;
/** Default cadence of the server-info refresh; see {@link SupervisorOptions.infoIntervalMs}. */
export const DEFAULT_INFO_INTERVAL_MS = 5_000;
/** Refresh hints arriving within this window are served by one RCON round-trip. */
const DEFAULT_HINT_DEBOUNCE_MS = 100;
/**
 * A hinted roster refresh is repeated once after this delay: Squad logs a join
 * a moment before `ListPlayers` lists the player, so the first read can miss
 * them and the second one catches them without waiting for the timer.
 */
const DEFAULT_HINT_FOLLOW_UP_MS = 1_500;

/**
 * What one supervised server does while its RCON connection is up: the
 * roster, server-info and full-poll refreshes, the hints that trigger them
 * out of band, and the status, seeding and squad-history writes they feed.
 * `PerServerSupervisor` adds the connection lifecycle on top; it only has to
 * start and stop the timers declared here.
 */
export abstract class ServerPoller {
  protected client?: RconClient;
  protected stopped = false;
  protected pollTimer?: NodeJS.Timeout;
  protected rosterTimer?: NodeJS.Timeout;
  protected infoTimer?: NodeJS.Timeout;
  protected hintTimer?: NodeJS.Timeout;
  protected followUpTimer?: NodeJS.Timeout;
  /** Scopes requested by hints and not yet served. */
  protected readonly pendingHints = new Set<RconRefreshScope>();
  /**
   * Set while any timer or hint holds the RCON client, so they never queue
   * commands on top of each other: the client serialises `exec`, and a
   * roster refresh waiting behind a full poll would fire late and pointlessly.
   */
  protected pollInFlight = false;
  /** A full poll tick arrived while a lighter refresh held the client. */
  protected fullPollPending = false;
  protected onDisconnect?: () => void;
  protected consecutivePollFails = 0;
  protected consecutiveLowTick = 0;
  protected rosterFirstSeen = new Map<string, string>();
  // Timestamp of the previous successful ListPlayers poll on the *current*
  // connection, used by accruePlayerKitTime to compute the elapsed interval.
  // Reset to null on every (re)connect so a poll right after reconnecting
  // never accrues kit time across the disconnected gap.
  protected lastKitAccrualAt: Date | null = null;
  // Timestamp of the last successful ListPlayers poll on the *current*
  // connection. PRESENCE: open player_sessions are closed at this instant when
  // the connection drops, so the unobserved gap is not credited as play time.
  protected lastSuccessfulPollAt: Date | null = null;
  protected readonly publisher: StatusPublisher;
  protected readonly seeding: SeedingTracker;
  protected readonly squadHistory: SquadHistory;
  protected readonly adminQueue: AdminCommandQueue;
  protected readonly events: ServerEvents;
  private readonly a2s: A2sProbe;

  constructor(
    protected readonly target: Target,
    protected readonly opts: SupervisorOptions,
  ) {
    this.publisher = new StatusPublisher(target, opts);
    this.seeding = new SeedingTracker(target, opts);
    this.squadHistory = new SquadHistory(target, opts);
    this.adminQueue = new AdminCommandQueue(target, opts, () => this.client);
    this.events = new ServerEvents(target, opts);
    this.a2s = new A2sProbe(target, opts);
  }

  /** The seed-layer lookup of {@link SeedingTracker}, reachable on the server object for `supervisor-layer-seed.test.ts`. */
  resolveLayerIsSeed(layerName: string | null): Promise<boolean | null> {
    return this.seeding.resolveLayerIsSeed(layerName);
  }

  protected clearTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.rosterTimer) clearInterval(this.rosterTimer);
    this.rosterTimer = undefined;
    if (this.infoTimer) clearInterval(this.infoTimer);
    this.infoTimer = undefined;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = undefined;
    this.pendingHints.clear();
  }

  /**
   * Asks for an out-of-band refresh because something just changed: a log
   * line announced a join, a leave or a new match, or the connection just
   * came up. Hints inside `hintDebounceMs` share one RCON round-trip; if a
   * timer holds the client, the hint waits for it rather than being dropped.
   * A roster hint is repeated once after `hintFollowUpMs` (see
   * {@link DEFAULT_HINT_FOLLOW_UP_MS}). `reason` `match.ended` /
   * `match.started` also resets squad history (see {@link SquadHistory.trackSquads}), even
   * while disconnected. Otherwise a no-op while disconnected: the connect path
   * requests a full refresh itself.
   */
  requestRefresh(scopes: RconRefreshScope[], reason?: string): void {
    this.squadHistory.noteMatchBoundary(reason);
    if (!this.client || this.stopped) return;
    for (const scope of scopes) this.pendingHints.add(scope);
    if (this.hintTimer) return;
    this.hintTimer = setTimeout(
      () => void this.drainHints(),
      this.opts.hintDebounceMs ?? DEFAULT_HINT_DEBOUNCE_MS,
    );
  }

  private async drainHints(): Promise<void> {
    this.hintTimer = undefined;
    if (!this.client || this.stopped || this.pendingHints.size === 0) return;
    if (this.pollInFlight) {
      // Busy with a timer tick; try again shortly instead of losing the hint.
      this.hintTimer = setTimeout(
        () => void this.drainHints(),
        this.opts.hintDebounceMs ?? DEFAULT_HINT_DEBOUNCE_MS,
      );
      return;
    }
    const scopes = new Set(this.pendingHints);
    this.pendingHints.clear();
    if (scopes.has('roster')) {
      await this.refreshRoster();
      if (this.followUpTimer) clearTimeout(this.followUpTimer);
      this.followUpTimer = setTimeout(() => {
        this.followUpTimer = undefined;
        void this.refreshRoster();
      }, this.opts.hintFollowUpMs ?? DEFAULT_HINT_FOLLOW_UP_MS);
    }
    if (scopes.has('info')) await this.refreshInfo();
  }

  /**
   * Refreshes only who is on the server and in which squad, every
   * `rosterIntervalMs` and on every roster hint, publishes `rcon.roster` — the
   * event the panel's live roster redraws on — and carries the new player and
   * squad counts into `rcon:status`. Apart from the rare squad lifecycle event
   * ({@link SquadHistory.trackSquads}) it deliberately does NOT touch the database, kit
   * time, seeding or A2S: those belong to the full poll, and
   * running them this often would multiply the write load for data that
   * changes once a match, not once a squad join.
   */
  protected scheduleRosterRefresh(): void {
    const interval = this.opts.rosterIntervalMs ?? DEFAULT_ROSTER_INTERVAL_MS;
    this.rosterTimer = setInterval(() => void this.refreshRoster(), interval);
  }

  private async refreshRoster(): Promise<void> {
    if (!this.client || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const rawPlayers = await this.client.exec('ListPlayers');
      const rawSquads = await this.client.exec('ListSquads');
      const players = parseListPlayers(rawPlayers);
      const squads = parseListSquads(rawSquads);
      const polledAt = new Date().toISOString();
      const { entries, firstSeen } = buildRoster(players, this.rosterFirstSeen, polledAt);
      this.rosterFirstSeen = firstSeen;
      await this.publisher.writeRoster(entries, polledAt);
      await this.publisher.writeSquads(squads, polledAt);
      await this.squadHistory.trackSquads(squads, players, polledAt);
      if (this.client && !this.stopped) {
        await this.publisher.writeStatus('connected', {
          player_count: players.length,
          squad_count: squads.length,
        });
      }
    } catch (err) {
      // The full poll owns failure handling (teardown after three strikes);
      // a missed refresh only costs one frame of freshness.
      this.opts.log.debug(
        { err: (err as Error).message, serverId: this.target.serverId },
        'roster refresh failed',
      );
    } finally {
      this.pollInFlight = false;
      this.resumeDeferredPoll();
    }
  }

  /**
   * Refreshes map, next layer, mode, public queue and tickrate every
   * `infoIntervalMs` and on every info hint. RCON only — no database, A2S or
   * seeding; the full poll still owns those.
   */
  protected scheduleInfoRefresh(): void {
    const interval = this.opts.infoIntervalMs ?? DEFAULT_INFO_INTERVAL_MS;
    this.infoTimer = setInterval(() => {
      // Whenever this tick lines up with the roster timer's (every 10 s at the
      // defaults, every tick when the intervals are equal) the roster refresh
      // holds the client first, and a plain skip would drop the info refresh
      // each time. Waiting as a hint serves it as soon as the client is free.
      if (this.pollInFlight) this.requestRefresh(['info']);
      else void this.refreshInfo();
    }, interval);
  }

  private async refreshInfo(): Promise<void> {
    if (!this.client || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const rawInfo = await this.client.exec('ShowServerInfo');
      const rawNextMap = await this.client.exec('ShowNextMap').catch(() => '');
      const info = rawInfo ? parseServerInfo(rawInfo) : null;
      const nextMap = rawNextMap ? parseShowNextMap(rawNextMap) : null;
      if (this.client && !this.stopped) {
        await this.publisher.writeStatus('connected', {
          tickrate_rt: info?.tickrate ?? undefined,
          current_map: info?.map_name ?? undefined,
          next_level: nextMap?.level ?? undefined,
          next_layer: nextMap?.layer ?? info?.next_layer ?? undefined,
          game_mode: info?.game_mode ?? undefined,
          public_queue: info?.public_queue ?? undefined,
        });
      }
    } catch (err) {
      this.opts.log.debug(
        { err: (err as Error).message, serverId: this.target.serverId },
        'server info refresh failed',
      );
    } finally {
      this.pollInFlight = false;
      this.resumeDeferredPoll();
    }
  }

  private resumeDeferredPoll(): void {
    if (this.fullPollPending && !this.stopped) void this.runFullPoll();
  }

  protected schedulePoll(): void {
    const interval = this.opts.pollIntervalMs ?? 30_000;
    this.pollTimer = setInterval(() => void this.runFullPoll(), interval);
  }

  /**
   * One full poll: RCON snapshot, player upsert, kit-time accrual, sessions,
   * seeding, then an A2S probe. When a roster or info refresh holds the client
   * the poll is not dropped: it is remembered in `fullPollPending` and started
   * as soon as that refresh finishes ({@link resumeDeferredPoll}). Skipping it
   * would postpone kit-time accrual, sessions and seeding by a whole interval
   * and make the next accrual look like a missed poll.
   */
  private async runFullPoll(): Promise<void> {
    if (!this.client) return;
    if (this.pollInFlight) {
      this.fullPollPending = true;
      return;
    }
    this.fullPollPending = false;
    this.pollInFlight = true;
    try {
      const start = Date.now();
      const rawPlayers = await this.client.exec('ListPlayers');
      const rawSquads = await this.client.exec('ListSquads');
      const rawInfo = await this.client.exec('ShowServerInfo').catch(() => '');
      const rawNextMap = await this.client.exec('ShowNextMap').catch(() => '');
      const players = parseListPlayers(rawPlayers);
      const squads = parseListSquads(rawSquads);
      const info = rawInfo ? parseServerInfo(rawInfo) : null;
      const nextMap = rawNextMap ? parseShowNextMap(rawNextMap) : null;
      // A database failure must not count as an RCON failure: three of those
      // in a row close a healthy client and its admin command queue (#981).
      try {
        await upsertPlayers(this.opts.db, players, (player, err) =>
          this.opts.log.warn(
            { serverId: this.target.serverId, eosId: player.eos_id, err: err.message },
            'player upsert failed',
          ),
        );
      } catch (err) {
        this.opts.log.warn(
          { err: (err as Error).message, serverId: this.target.serverId },
          'player upsert failed (db); rcon connection unaffected',
        );
      }
      const pollAt = new Date();
      try {
        await accruePlayerKitTime(
          this.opts.db,
          players,
          this.lastKitAccrualAt,
          pollAt,
          this.target.serverId,
          this.opts.pollIntervalMs ?? 30_000,
        );
      } catch (err) {
        this.opts.log.warn(
          { err: (err as Error).message, serverId: this.target.serverId },
          'kit-time accrual failed (db); rcon connection unaffected',
        );
      }
      this.lastKitAccrualAt = pollAt;
      this.consecutivePollFails = 0;
      const polledAt = pollAt.toISOString();
      const { entries, firstSeen } = buildRoster(players, this.rosterFirstSeen, polledAt);
      this.rosterFirstSeen = firstSeen;
      await this.reconcileSessions(players, firstSeen, pollAt);
      this.lastSuccessfulPollAt = pollAt;
      await this.publisher.writeRoster(entries, polledAt);
      await this.publisher.writeSquads(squads, polledAt);
      await this.squadHistory.trackSquads(squads, players, polledAt);
      const pollMs = Date.now() - start;
      this.opts.log.info(
        {
          serverId: this.target.serverId,
          ms: pollMs,
          n: players.length,
          squads: squads.length,
        },
        'poll listplayers',
      );
      await this.events.emitEvent('rcon.players_polled', {
        players: players
          .filter((p) => p.steam_id64 !== null)
          .map((p) => ({
            steam_id64: p.steam_id64,
            eos_id: p.eos_id,
            name: p.name,
            team_id: p.team_id,
            squad_id: p.squad_id,
            is_leader: p.is_leader ?? false,
            role: p.role ?? undefined,
          })),
        polled_at: polledAt,
        latency_ms: Date.now() - start,
      });
      // A poll still in flight when stop() ran must not write 'connected' or
      // seeding events for a supervisor already torn down (#982).
      if (this.client && !this.stopped) {
        await this.publisher.writeStatus('connected', {
          player_count: players.length,
          last_poll_at: new Date().toISOString(),
          tickrate_rt: info?.tickrate ?? undefined,
          current_map: info?.map_name ?? undefined,
          next_level: nextMap?.level ?? undefined,
          next_layer: nextMap?.layer ?? info?.next_layer ?? undefined,
          game_mode: info?.game_mode ?? undefined,
          squad_count: squads.length,
          // DISCORD-6 (#153): the Discord status channel renders
          // {players}x{queue}, and this cache is its only source for the queue —
          // ShowServerInfo already parses PublicQueue_I, it just was not stored.
          public_queue: info?.public_queue ?? undefined,
        });
      }

      if (typeof info?.tickrate === 'number') {
        const configured = this.target.tickrate ?? 50;
        const threshold = configured * 0.8;
        if (info.tickrate < threshold) {
          this.consecutiveLowTick++;
          if (this.consecutiveLowTick >= 3) {
            this.opts.log.warn(
              {
                serverId: this.target.serverId,
                tickrate: info.tickrate,
                threshold,
                configured,
                consecutive_low: this.consecutiveLowTick,
              },
              'performance degraded: tickrate below threshold',
            );
            await this.events.emitEvent('performance.degraded', {
              tickrate: info.tickrate,
              threshold,
              configured,
              consecutive_low: this.consecutiveLowTick,
            });
          }
        } else {
          this.consecutiveLowTick = 0;
        }
      }

      if (!this.stopped) {
        await this.seeding.tickSeeding(players.length, info?.map_name ?? null, polledAt);
      }
    } catch (err) {
      this.consecutivePollFails += 1;
      const reason = (err as Error).message;
      this.opts.log.warn(
        { err: reason, serverId: this.target.serverId, fails: this.consecutivePollFails },
        'ListPlayers poll failed',
      );
      await this.publisher.writeStatus('connecting', {
        reason: 'poll-failed',
        last_error: reason,
        consecutive_fails: this.consecutivePollFails,
      });
      if (this.consecutivePollFails >= 3) {
        this.opts.log.warn(
          { serverId: this.target.serverId },
          'tearing down rcon client after 3 consecutive poll failures',
        );
        this.consecutivePollFails = 0;
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        this.onDisconnect?.();
      }
    } finally {
      // The A2S probe below needs no RCON client, so the roster refresh may
      // resume as soon as the RCON part of the tick is done.
      this.pollInFlight = false;
    }

    await this.a2s.probe();
  }

  /**
   * Reconciles `player_sessions` against this poll's roster (PRESENCE).
   * Best-effort: a presence write must never count as a poll failure and tear
   * down an otherwise healthy RCON connection.
   */
  private async reconcileSessions(
    players: RconPlayer[],
    firstSeen: Map<string, string>,
    pollAt: Date,
  ): Promise<void> {
    if (this.stopped) return;
    try {
      await reconcilePlayerSessions(this.opts.db, {
        serverId: this.target.serverId,
        onlinePlayers: players,
        pollAt,
        firstSeenByEosId: firstSeen,
        mode: this.seeding.seedingState?.state === 'seeding' ? 'seed' : 'online',
        pollIntervalMs: this.opts.pollIntervalMs ?? 30_000,
      });
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, serverId: this.target.serverId },
        'player session reconcile failed',
      );
    }
  }

  /**
   * Closes the server's open sessions when the RCON connection goes away, at
   * the last successful poll — anything after that instant was never observed.
   * The roster's first-seen map is dropped with it so a player still online on
   * reconnect starts a fresh session instead of resuming the stale one.
   */
  protected async closeOpenSessions(): Promise<void> {
    const closedAt = this.lastSuccessfulPollAt ?? new Date();
    this.lastSuccessfulPollAt = null;
    this.lastKitAccrualAt = null;
    this.rosterFirstSeen = new Map();
    try {
      const closed = await closeServerSessions(this.opts.db, this.target.serverId, closedAt);
      if (closed > 0) {
        this.opts.log.info(
          { serverId: this.target.serverId, closed, closedAt: closedAt.toISOString() },
          'closed open player sessions after rcon disconnect',
        );
      }
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, serverId: this.target.serverId },
        'closing open player sessions failed',
      );
    }
  }
}
