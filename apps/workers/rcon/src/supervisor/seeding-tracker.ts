import {
  events,
  layers,
  notifySeedSubscribers,
  serverSettings,
  servers,
  splitOpenSessionsAtSeedingTransition,
} from '@squad/db';
import { seedPublicHost } from '@squad/shared-config';
import { type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  computeSeedingTick,
  isSeedLayer,
  type SeedingState,
  seedingStateSchema,
} from '../seeding.js';
import type { SupervisorOptions, Target } from './types.js';

/** Defaults mirror `server_settings.seed_live_at` / `seed_hysteresis` (SEED-1, #140). */
const DEFAULT_SEED_LIVE_AT = 60;
const DEFAULT_SEED_HYSTERESIS = 5;

/**
 * One server's seeding state machine (SEED-1, #140) and everything it
 * publishes: the `seeding:state:<serverId>` cache, the `server.seeding` live
 * event and the durable `server.seeding_started` / `server.seeding_ended`
 * transitions.
 */
export class SeedingTracker {
  // Seeding state machine (SEED-1, #140). Loaded from redis on start() so a
  // worker restart mid-seeding does not emit a spurious duplicate `started`.
  seedingState: SeedingState | null = null;
  private seedingStateLoaded = false;
  private readonly layerIsSeedCache = new Map<string, boolean | null>();

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {}

  async loadPriorSeedingState(): Promise<void> {
    if (this.seedingStateLoaded) return;
    this.seedingStateLoaded = true;
    try {
      const raw = await this.opts.redis.get(`seeding:state:${this.target.serverId}`);
      if (!raw) return;
      const parsed = seedingStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.seedingState = parsed.data;
    } catch {
      // best-effort restore; a missing/invalid key just means we start fresh
    }
  }

  /**
   * Resolves whether `layerName` is a seed layer via the layers catalog
   * (ROT-1, `is_seed`), caching the result per layer name for the lifetime
   * of this supervisor. A lookup failure (or an unknown layer) resolves to
   * `null`, which makes `isSeedLayer()` fall back to the `/seed/i` regex —
   * catalog lookups are best-effort and must never derail polling.
   */
  async resolveLayerIsSeed(layerName: string | null): Promise<boolean | null> {
    if (!layerName) return null;
    if (this.layerIsSeedCache.has(layerName)) return this.layerIsSeedCache.get(layerName) ?? null;
    try {
      const rows = await this.opts.db
        .select({ isSeed: layers.isSeed })
        .from(layers)
        .where(eq(layers.name, layerName))
        .limit(1);
      const result = rows[0]?.isSeed ?? null;
      this.layerIsSeedCache.set(layerName, result);
      return result;
    } catch {
      // Not cached: a transient database error must not pin this layer to the
      // name-based fallback until the supervisor restarts.
      return null;
    }
  }

  private async writeSeedingState(state: SeedingState): Promise<void> {
    const key = `seeding:state:${this.target.serverId}`;
    try {
      await this.opts.redis.set(key, JSON.stringify(state), 'EX', 3600);
    } catch {
      // telemetry only; the in-memory state machine remains authoritative
      // for this process
    }
  }

  private async publishSeedingLiveEvent(state: SeedingState): Promise<void> {
    try {
      await this.opts.redis.publish(
        'live-bus',
        JSON.stringify({
          type: 'server.seeding',
          ts: state.updated_at,
          data: {
            server_id: this.target.serverId,
            state: state.state,
            current_players: state.current_players,
            live_at: state.live_at,
            progress_pct: state.progress_pct,
            started_at: state.started_at,
            layer: state.layer,
          },
        }),
      );
    } catch {
      // best-effort fan-out; GET /api/v1/servers/:id/seeding reads redis
      // state directly, so a missed publish only delays the live UI update
    }
  }

  /**
   * Emits a `server.seeding_started` / `server.seeding_ended` transition:
   * XADDs the envelope to the server's event stream (as with every other
   * worker-rcon event) AND inserts it directly into the `events` table.
   * Stream events are otherwise only consumed by automation, not persisted —
   * seeding transitions need a durable audit trail (`SELECT ... FROM events
   * WHERE kind LIKE 'server.seeding%'`), so this worker persists them itself.
   */
  private async emitSeedingTransition(
    type: 'server.seeding_started' | 'server.seeding_ended',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventId = uuidv7();
    const ts = new Date();
    let eventPayload = payload;
    if (type === 'server.seeding_started') {
      try {
        const [server, settings] = await Promise.all([
          this.opts.db.query.servers.findFirst({
            where: and(eq(servers.id, this.target.serverId), isNull(servers.deletedAt)),
          }),
          this.opts.db.query.serverSettings.findFirst({
            where: eq(serverSettings.serverId, this.target.serverId),
          }),
        ]);
        if (server && settings) {
          // Never `this.target.host`: that is the RCON dial target (loopback
          // for a local server), useless to a player's Steam client (#980).
          // The link is omitted when no public host is configured.
          const publicHost = seedPublicHost();
          eventPayload = {
            ...payload,
            server_name: server.displayName,
            ...(publicHost
              ? { join_link: `steam://connect/${publicHost}:${settings.gamePort}` }
              : {}),
          };
        }
      } catch (err) {
        this.opts.log.warn(
          { err: (err as Error).message, serverId: this.target.serverId },
          'seeding notification context lookup failed',
        );
      }
    }
    const envelope: EventEnvelope = {
      event_id: eventId,
      version: 1,
      type,
      server_id: this.target.serverId,
      ts: ts.toISOString(),
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload: eventPayload,
    };
    try {
      await splitOpenSessionsAtSeedingTransition(this.opts.db, {
        serverId: this.target.serverId,
        occurredAt: ts,
        kind: type,
      });
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message, type }, 'seeding session split failed');
    }
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
      this.opts.log.warn({ err: (err as Error).message, type }, 'event publish failed');
    }
    try {
      await this.opts.db
        .insert(events)
        .values({
          eventId,
          serverId: this.target.serverId,
          occurredAt: ts,
          kind: type,
          version: 1,
          actorKind: 'system',
          actorId: null,
          correlationId: null,
          payload: eventPayload,
        })
        .onConflictDoNothing({ target: [events.eventId, events.occurredAt] });
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message, type }, 'seeding event persist failed');
    }
    if (type === 'server.seeding_started') {
      await notifySeedSubscribers(this.opts.db, this.opts.redis, {
        serverId: this.target.serverId,
        eventKind: 'server.seeding_started',
        payload: eventPayload,
      }).catch((err: unknown) => {
        this.opts.log.warn(
          { err: (err as Error).message, serverId: this.target.serverId },
          'seeding alert notification failed',
        );
      });
    }
  }

  /**
   * Advances the seeding state machine (see `seeding.ts`) for this poll,
   * refreshes the `seeding:state:<serverId>` redis cache read by
   * `GET /api/v1/servers/:id/seeding`, and — on a state transition or a
   * progress-percentage change — publishes a `server.seeding` live-bus event
   * so the panel UI updates without a page reload.
   */
  async tickSeeding(
    playerCount: number,
    layerName: string | null,
    polledAt: string,
  ): Promise<void> {
    const catalogIsSeed = await this.resolveLayerIsSeed(layerName);
    const seedLayer = isSeedLayer(layerName, catalogIsSeed);
    const liveAt = this.target.seedLiveAt ?? DEFAULT_SEED_LIVE_AT;
    const hysteresis = this.target.seedHysteresis ?? DEFAULT_SEED_HYSTERESIS;

    const previousProgressPct = this.seedingState?.progress_pct ?? null;
    const tick = computeSeedingTick(this.seedingState, {
      playerCount,
      seedLayer,
      liveAt,
      hysteresis,
      now: polledAt,
      layer: layerName,
    });
    this.seedingState = tick.state;
    await this.writeSeedingState(tick.state);

    if (tick.transition) {
      const eventType =
        tick.transition === 'started' ? 'server.seeding_started' : 'server.seeding_ended';
      await this.emitSeedingTransition(eventType, {
        player_count: tick.state.current_players,
        layer: tick.state.layer,
        live_at: tick.state.live_at,
        hysteresis,
        progress_pct: tick.state.progress_pct,
      });
      await this.publishSeedingLiveEvent(tick.state);
    } else if (previousProgressPct !== tick.state.progress_pct) {
      await this.publishSeedingLiveEvent(tick.state);
    }
  }
}
