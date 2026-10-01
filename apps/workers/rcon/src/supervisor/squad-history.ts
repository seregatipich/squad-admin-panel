import { events } from '@squad/db';
import {
  type EventEnvelope,
  SQUAD_CROWNS_TTL_SECONDS,
  STREAM_NAME,
  squadCrownsKey,
} from '@squad/shared-types';
import { v7 as uuidv7 } from 'uuid';
import type { RconPlayer } from '../parse-list-players.js';
import type { RconSquad } from '../parse-list-squads.js';
import type { SquadCreatedBroadcast } from '../squad-broadcast.js';
import { applySquadEvent, type CrownBook, crownBookFromHash, crownOf } from '../squad-crowns.js';
import {
  buildSquadSnapshot,
  diffSquads,
  type SquadEvent,
  type SquadSnapshot,
} from '../squad-tracker.js';
import type { SupervisorOptions, Target } from './types.js';

const SQUAD_BROADCAST_TTL_MS = 10_000;

/**
 * One server's squad history (see `squad-tracker.ts`): the snapshot each
 * refresh is diffed against, the creation broadcasts waiting to date a new
 * squad, and the creator crown book mirrored into `rcon:squad-crowns:{id}`.
 */
export class SquadHistory {
  /**
   * Squad history (see `squad-tracker.ts`). `squadState` is the previous
   * refresh's snapshot; `null` makes the next refresh a baseline (worker start,
   * RCON reconnect, match reset).
   */
  private squadState: SquadSnapshot | null = null;
  /** Set by a `match.started`/`match.ended` hint; consumed by the next {@link trackSquads}. */
  private squadResetPending = false;
  /**
   * Set by `match.ended`: every snapshot stays a baseline until one lists no
   * squads (the next map loaded) or `match.started` arrives, so the old map's
   * squads vanishing is never reported as disbands.
   */
  private squadHoldUntilEmpty = false;
  /** Parsed creation broadcasts waiting for the refresh that lists their squad. */
  private pendingSquadBroadcasts: SquadCreatedBroadcast[] = [];
  /** Current match's creator histories, mirrored into `rcon:squad-crowns:{id}`. */
  private crownBook: CrownBook = new Map();

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {}

  /**
   * Applies the squad-history side of a refresh hint: a `match.started` or
   * `match.ended` reason makes the next {@link trackSquads} a baseline.
   */
  noteMatchBoundary(reason?: string): void {
    if (reason === 'match.ended') {
      this.squadResetPending = true;
      this.squadHoldUntilEmpty = true;
    } else if (reason === 'match.started') {
      this.squadResetPending = true;
      this.squadHoldUntilEmpty = false;
    }
  }

  /** Makes the next refresh a baseline, never a burst of events (RCON reconnect). */
  resetBaseline(): void {
    this.squadState = null;
  }

  /** Queues a parsed creation broadcast for the refresh that first lists its squad. */
  queueBroadcast(broadcast: SquadCreatedBroadcast): void {
    this.pendingSquadBroadcasts.push(broadcast);
  }

  /**
   * Restores the current match's crowns after a worker restart so a creator's
   * later handoffs extend the stored entry instead of replacing it.
   * Best-effort: a missing or unreadable hash starts the match history empty.
   */
  async loadPriorCrowns(): Promise<void> {
    try {
      this.crownBook = crownBookFromHash(
        await this.opts.redis.hgetall(squadCrownsKey(this.target.serverId)),
      );
    } catch {
      this.crownBook = new Map();
    }
  }

  /**
   * Turns this refresh's `ListSquads` + `ListPlayers` into squad history:
   * persists each `squad.*` event and keeps `rcon:squad-crowns:{id}` current.
   * Never throws: squad history is a moderation aid and must not cost the
   * roster its refresh.
   *
   * A `match.started`/`match.ended` hint clears the crowns and makes this
   * snapshot a baseline; after `match.ended` snapshots stay baselines until one
   * lists no squads (see {@link squadHoldUntilEmpty}). The broadcast queue is
   * filtered, diffed and replaced without an `await` in between, so a
   * broadcast arriving meanwhile is never lost.
   */
  async trackSquads(squads: RconSquad[], players: RconPlayer[], polledAt: string): Promise<void> {
    try {
      if (this.squadResetPending) {
        this.squadResetPending = false;
        this.squadState = null;
        this.pendingSquadBroadcasts = [];
        await this.clearCrowns();
      }
      if (this.squadHoldUntilEmpty) {
        this.squadState = null;
        if (squads.length === 0) this.squadHoldUntilEmpty = false;
      }
      const cutoff = Date.parse(polledAt) - SQUAD_BROADCAST_TTL_MS;
      const fresh = this.pendingSquadBroadcasts.filter(
        (broadcast) => Date.parse(broadcast.at) >= cutoff,
      );
      const diff = diffSquads(
        this.squadState,
        buildSquadSnapshot(squads, players, polledAt),
        fresh,
      );
      this.squadState = diff.state;
      this.pendingSquadBroadcasts = diff.pending;
      if (diff.reset) {
        await this.clearCrowns();
        return;
      }
      const changedCreators = new Set<string>();
      for (const event of diff.events) {
        await this.emitSquadEvent(event);
        const creator = applySquadEvent(this.crownBook, event);
        if (creator) changedCreators.add(creator);
      }
      await this.writeCrowns(changedCreators);
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, serverId: this.target.serverId },
        'squad tracking failed',
      );
    }
  }

  /**
   * Publishes one squad lifecycle event the way `SeedingTracker`
   * does for its transitions: XADD to the server stream and a direct `events` insert, because
   * stream events are otherwise never persisted. `actor_id` is the EOS id of
   * the player the event is about (the creator, or the leader who gave up
   * command), so `events_actor_occurred_idx` serves per-player lookups.
   */
  private async emitSquadEvent(event: SquadEvent): Promise<void> {
    const eventId = uuidv7();
    const actorId =
      event.type === 'squad.leader_changed'
        ? event.payload.from.eos_id
        : event.payload.creator.eos_id;
    const envelope: EventEnvelope = {
      event_id: eventId,
      version: 1,
      type: event.type,
      server_id: this.target.serverId,
      ts: event.at,
      actor: { kind: 'player', id: actorId },
      correlation_id: null,
      payload: event.payload,
    };
    try {
      await this.opts.redis.xadd(
        STREAM_NAME.eventsServer(this.target.serverId),
        'MAXLEN',
        '~',
        '10000',
        '*',
        'envelope',
        JSON.stringify(envelope),
      );
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message, type: event.type }, 'event publish failed');
    }
    try {
      await this.opts.db
        .insert(events)
        .values({
          eventId,
          serverId: this.target.serverId,
          occurredAt: new Date(event.at),
          kind: event.type,
          version: 1,
          actorKind: 'player',
          actorId,
          correlationId: null,
          payload: event.payload,
        })
        .onConflictDoNothing({ target: [events.eventId, events.occurredAt] });
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, type: event.type },
        'squad event persist failed',
      );
    }
  }

  /** Writes the crowns of `creators` that have one and refreshes the hash TTL. */
  private async writeCrowns(creators: ReadonlySet<string>): Promise<void> {
    const fields: Record<string, string> = {};
    for (const eosId of creators) {
      const history = this.crownBook.get(eosId);
      const crown = history ? crownOf(history) : null;
      if (crown) fields[eosId] = JSON.stringify(crown);
    }
    if (Object.keys(fields).length === 0) return;
    const key = squadCrownsKey(this.target.serverId);
    await this.opts.redis.hset(key, fields);
    await this.opts.redis.expire(key, SQUAD_CROWNS_TTL_SECONDS);
  }

  /** Forgets the match's crowns, in memory and in Redis. */
  private async clearCrowns(): Promise<void> {
    this.crownBook = new Map();
    await this.opts.redis.del(squadCrownsKey(this.target.serverId));
  }
}
