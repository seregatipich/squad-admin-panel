import { type ChatFlagDetector, handleChat } from '@squad/chat-ingest';
import {
  type DatabaseClient,
  events,
  type GeoLookup,
  layers,
  notifySeedSubscribers,
  serverSettings,
  servers,
  splitOpenSessionsAtSeedingTransition,
} from '@squad/db';
import type { Diag } from '@squad/diag';
import { CONSUMER_GROUP, type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { queryA2S } from './a2s.js';
import { parseRconChatLine } from './chat.js';
import { RconClient } from './client.js';
import { RconCommandQueue } from './commands.js';
import { parseListPlayers } from './parse-list-players.js';
import { parseListSquads, type RconSquad } from './parse-list-squads.js';
import { parseServerInfo } from './parse-server-info.js';
import { parseShowNextMap } from './parse-show-next-map.js';
import { accruePlayerKitTime, upsertPlayers } from './persist.js';
import { buildRoster, type RosterEntry } from './roster.js';
import { computeSeedingTick, isSeedLayer, type SeedingState } from './seeding.js';

/** Defaults mirror `server_settings.seed_live_at` / `seed_hysteresis` (SEED-1, #140). */
const DEFAULT_SEED_LIVE_AT = 60;
const DEFAULT_SEED_HYSTERESIS = 5;

export interface Target {
  serverId: string;
  host: string;
  port: number;
  queryPort: number;
  tickrate?: number;
  seedLiveAt?: number;
  seedHysteresis?: number;
  password: string;
}

export interface SupervisorOptions {
  db: DatabaseClient;
  redis: Redis;
  log: Logger;
  diag?: Diag;
  pollIntervalMs?: number;
  /**
   * Cadence of the light roster refresh (`ListPlayers` + `ListSquads` only).
   * Defaults to 5s: the panel's live roster is redrawn from the event this
   * refresh publishes, so it is what "the list is live" actually costs.
   */
  rosterIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  geoLookup?: GeoLookup | null;
  /**
   * Profanity/flag matcher applied to incoming chat (CHATLOG-5). Shared across
   * every supervisor so the rule cache is loaded once.
   */
  chatFlagDetector?: ChatFlagDetector | null;
}

/** True when the parameters that pick the TCP/UDP endpoint or the AUTH secret differ. */
function connectionChanged(a: Target, b: Target): boolean {
  return (
    a.host !== b.host ||
    a.port !== b.port ||
    a.password !== b.password ||
    a.queryPort !== b.queryPort
  );
}

export class RconSupervisor {
  private readonly targets = new Map<string, Target>();
  private readonly supervisors = new Map<string, PerServerSupervisor>();

  constructor(private readonly opts: SupervisorOptions) {}

  async reconcile(targets: Target[]): Promise<void> {
    const incoming = new Map(targets.map((t) => [t.serverId, t]));
    const added: string[] = [];
    const removed: string[] = [];
    const redialed: string[] = [];
    for (const [id, t] of incoming) {
      const previous = this.targets.get(id);
      if (this.supervisors.has(id) && previous && connectionChanged(previous, t)) {
        // The operator repointed the server (host/port/password edit on an
        // external server, or a rotated Rcon.cfg). The running supervisor
        // holds the old dial parameters, so replace it rather than let it
        // retry a dead endpoint until the next worker restart.
        await this.supervisors.get(id)?.stop();
        this.supervisors.delete(id);
        redialed.push(id);
      }
      if (!this.supervisors.has(id)) {
        const sup = new PerServerSupervisor(t, this.opts);
        this.supervisors.set(id, sup);
        this.targets.set(id, t);
        if (!redialed.includes(id)) added.push(id);
        sup.start();
      } else {
        this.targets.set(id, t);
      }
    }
    for (const id of Array.from(this.supervisors.keys())) {
      if (!incoming.has(id)) {
        await this.supervisors.get(id)?.stop();
        this.supervisors.delete(id);
        this.targets.delete(id);
        removed.push(id);
      }
    }
    if ((added.length || removed.length || redialed.length) && this.opts.diag) {
      const total = this.supervisors.size;
      this.opts.diag
        .emit({
          component: 'worker-rcon',
          kind: 'rcon.targets.changed',
          severity: 'info',
          message: `targets changed: +${added.length}, -${removed.length}, ~${redialed.length}, total=${total}`,
          payload: { added, removed, redialed, total },
        })
        .catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    for (const sup of this.supervisors.values()) await sup.stop();
    this.supervisors.clear();
    this.targets.clear();
  }

  size(): number {
    return this.supervisors.size;
  }
}

class PerServerSupervisor {
  private client?: RconClient;
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;
  private rosterTimer?: NodeJS.Timeout;
  /**
   * Set while either timer holds the RCON client, so the two never queue
   * commands on top of each other: the client serialises `exec`, and a
   * roster refresh waiting behind a full poll would fire late and pointlessly.
   */
  private pollInFlight = false;
  private backoffMs: number;
  private onDisconnect?: () => void;
  /** Serialises chat ingestion for this server; see {@link ingestBroadcast}. */
  private chatQueue: Promise<void> = Promise.resolve();
  private consecutivePollFails = 0;
  private consecutiveA2SFails = 0;
  private consecutiveLowTick = 0;
  private rosterFirstSeen = new Map<string, string>();
  private commandQueue?: RconCommandQueue;
  // Timestamp of the previous successful ListPlayers poll on the *current*
  // connection, used by accruePlayerKitTime to compute the elapsed interval.
  // Reset to null on every (re)connect so a poll right after reconnecting
  // never accrues kit time across the disconnected gap.
  private lastKitAccrualAt: Date | null = null;
  // Seeding state machine (SEED-1, #140). Loaded from redis on start() so a
  // worker restart mid-seeding does not emit a spurious duplicate `started`.
  private seedingState: SeedingState | null = null;
  private seedingStateLoaded = false;
  private readonly layerIsSeedCache = new Map<string, boolean | null>();

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {
    this.backoffMs = opts.initialBackoffMs ?? 1000;
  }

  async start(): Promise<void> {
    await this.loadPriorSeedingState();
    this.connectLoop().catch((err) =>
      this.opts.log.error(
        { err: (err as Error).message, serverId: this.target.serverId },
        'supervisor failed',
      ),
    );
  }

  private async loadPriorSeedingState(): Promise<void> {
    if (this.seedingStateLoaded) return;
    this.seedingStateLoaded = true;
    try {
      const raw = await this.opts.redis.get(`seeding:state:${this.target.serverId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SeedingState;
      if (parsed && (parsed.state === 'seeding' || parsed.state === 'live')) {
        this.seedingState = parsed;
      }
    } catch {
      // best-effort restore; a missing/invalid key just means we start fresh
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    await this.stopCommandQueue();
    await this.client?.close();
    this.client = undefined;
  }

  private async writeStatus(
    state: 'connected' | 'disconnected' | 'connecting',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const key = `rcon:status:${this.target.serverId}`;
    const value = JSON.stringify({ state, ts: new Date().toISOString(), ...extra });
    try {
      // 5-minute TTL; a worker crash or network cut removes the stale key.
      await this.opts.redis.set(key, value, 'EX', 300);
    } catch {
      // telemetry only; swallow
    }
    try {
      const playerCount =
        typeof extra.player_count === 'number' ? (extra.player_count as number) : undefined;
      await this.opts.redis.publish(
        'rcon:status:changed',
        JSON.stringify({
          server_id: this.target.serverId,
          state,
          ...(playerCount !== undefined ? { player_count: playerCount } : {}),
        }),
      );
    } catch {
      // best-effort fan-out; the SET above is the source of truth
    }
  }

  private async writeRoster(entries: RosterEntry[], polledAt: string): Promise<void> {
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
    } catch {
      // best-effort fan-out; the SET above is the source of truth
    }
  }

  private async writeSquads(squads: RconSquad[], polledAt: string): Promise<void> {
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

  /**
   * Resolves whether `layerName` is a seed layer via the layers catalog
   * (ROT-1, `is_seed`), caching the result per layer name for the lifetime
   * of this supervisor. A lookup failure (or an unknown layer) resolves to
   * `null`, which makes `isSeedLayer()` fall back to the `/seed/i` regex —
   * catalog lookups are best-effort and must never derail polling.
   */
  private async resolveLayerIsSeed(layerName: string | null): Promise<boolean | null> {
    if (!layerName) return null;
    if (this.layerIsSeedCache.has(layerName)) return this.layerIsSeedCache.get(layerName) ?? null;
    let result: boolean | null = null;
    try {
      const rows = await this.opts.db
        .select({ isSeed: layers.isSeed })
        .from(layers)
        .where(eq(layers.name, layerName))
        .limit(1);
      result = rows[0]?.isSeed ?? null;
    } catch {
      result = null;
    }
    this.layerIsSeedCache.set(layerName, result);
    return result;
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
          eventPayload = {
            ...payload,
            server_name: server.displayName,
            join_link: `steam://connect/${this.target.host}:${settings.gamePort}`,
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
  private async tickSeeding(
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

  /**
   * Handle one unsolicited RCON packet.
   *
   * Squad delivers in-game chat only this way — it is not in SquadGame.log —
   * so this is the sole live-chat producer for a running server. Non-chat
   * broadcasts (admin camera, squad creation, kicks) parse to null and are
   * ignored.
   *
   * Ingestion is queued rather than fired off per packet: each message costs
   * several identity queries plus an insert, and a chat flood would otherwise
   * open them all at once and let the archive rows land out of order. The
   * queue is per server and never awaited by the caller, so a slow database
   * cannot stall the socket's read loop or the poll timers.
   */
  private ingestBroadcast(body: string): void {
    const chat = parseRconChatLine(body, new Date().toISOString());
    if (!chat) return;
    this.chatQueue = this.chatQueue
      .then(() =>
        handleChat(
          this.opts.db,
          this.opts.redis,
          {
            serverId: this.target.serverId,
            chat,
            source: 'rcon',
            onArchiveError: (err) =>
              this.opts.log.warn(
                { err: err.message, serverId: this.target.serverId },
                'rcon chat archive insert failed',
              ),
          },
          this.opts.chatFlagDetector ?? null,
        ),
      )
      .then(
        () => undefined,
        (err: Error) =>
          this.opts.log.warn(
            { err: err.message, serverId: this.target.serverId },
            'rcon chat ingest failed',
          ),
      );
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      let lastDisconnectReason: string | undefined;
      try {
        await this.writeStatus('connecting', { backoffMs: this.backoffMs });
        const disconnected = new Promise<void>((resolve) => {
          this.onDisconnect = resolve;
        });
        this.client = new RconClient({
          host: this.target.host,
          port: this.target.port,
          password: this.target.password,
          log: this.opts.log.child({ serverId: this.target.serverId }),
          onDisconnect: (reason) => {
            this.opts.log.warn(
              { serverId: this.target.serverId, reason },
              'rcon client disconnected',
            );
            lastDisconnectReason = reason;
            this.onDisconnect?.();
          },
          onBroadcast: (body) => this.ingestBroadcast(body),
        });
        await this.client.connect();
        this.opts.log.info(
          {
            serverId: this.target.serverId,
            host: this.target.host,
            port: this.target.port,
          },
          'connect: rcon authenticated',
        );
        this.backoffMs = this.opts.initialBackoffMs ?? 1000;
        this.lastKitAccrualAt = null;
        await this.emitEvent('rcon.connected', {});
        await this.emitDiag({
          kind: 'rcon.connected',
          severity: 'info',
          message: `rcon connected ${this.target.host}:${this.target.port}`,
          payload: { host: this.target.host, port: this.target.port },
        });
        await this.writeStatus('connected');
        await this.startCommandQueue();
        this.schedulePoll();
        this.scheduleRosterRefresh();
        await Promise.race([
          disconnected,
          new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (this.stopped) {
                clearInterval(check);
                resolve();
              }
            }, 1000);
          }),
        ]);
      } catch (err) {
        const msg = (err as Error).message;
        this.opts.log.warn(
          {
            err: msg,
            serverId: this.target.serverId,
            backoffMs: this.backoffMs,
          },
          'rcon connect failed',
        );
        this.opts.log.warn(
          {
            serverId: this.target.serverId,
            backoffMs: this.backoffMs,
          },
          `reconnect in ${this.backoffMs}ms`,
        );
        if (msg === 'rcon auth rejected' || msg === 'rcon auth timeout') {
          await this.emitDiag({
            kind: 'rcon.auth_failed',
            severity: 'error',
            message: 'rcon auth failed',
            payload: { host: this.target.host, port: this.target.port, err: msg },
          });
        }
        lastDisconnectReason = msg;
      } finally {
        this.clearTimers();
        await this.stopCommandQueue();
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        await this.emitEvent('rcon.disconnected', {});
        await this.emitDiag({
          kind: 'rcon.disconnected',
          severity: 'warn',
          message: `rcon disconnected: ${lastDisconnectReason ?? 'unknown'}`,
          payload: {
            host: this.target.host,
            port: this.target.port,
            reason: lastDisconnectReason ?? 'unknown',
          },
        });
      }
      if (!this.stopped) {
        // Stay in 'connecting' (not 'disconnected') during backoff so the
        // panel UI shows the amber dot continuously instead of flashing red
        // between retries. Retry attempts are expected transient.
        await this.writeStatus('connecting', {
          backoffMs: this.backoffMs,
          reason: 'reconnect-backoff',
        });
        await this.emitDiag({
          kind: 'rcon.reconnect_attempt',
          severity: 'warn',
          message: `reconnect in ${this.backoffMs}ms`,
          payload: {
            host: this.target.host,
            port: this.target.port,
            backoffMs: this.backoffMs,
          },
        });
        await new Promise((r) => setTimeout(r, this.backoffMs));
        this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 60_000);
      } else {
        await this.writeStatus('disconnected', { reason: 'supervisor-stopped' });
      }
    }
  }

  private async startCommandQueue(): Promise<void> {
    if (this.commandQueue || !this.client) return;
    const queue = new RconCommandQueue({
      redis: this.opts.redis,
      log: this.opts.log.child({
        serverId: this.target.serverId,
        component: 'rcon-command-queue',
      }),
      serverId: this.target.serverId,
      execute: async (command) => {
        if (!this.client) throw new Error('rcon not connected');
        return await this.client.exec(command);
      },
    });
    try {
      await queue.start();
      this.commandQueue = queue;
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, serverId: this.target.serverId },
        'rcon command queue unavailable',
      );
      await queue.stop().catch(() => undefined);
    }
  }

  private async stopCommandQueue(): Promise<void> {
    const queue = this.commandQueue;
    this.commandQueue = undefined;
    await queue?.stop();
  }

  private clearTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.rosterTimer) clearInterval(this.rosterTimer);
    this.rosterTimer = undefined;
  }

  /**
   * Refreshes only who is on the server and in which squad, every
   * `rosterIntervalMs`, and publishes `rcon.roster` — the event the panel's
   * live roster redraws on. It deliberately does NOT touch the database, kit
   * time, seeding, A2S or the server-info status: those belong to the full
   * poll, and running them six times as often would multiply the write load
   * for data that changes once a match, not once a squad join.
   */
  private scheduleRosterRefresh(): void {
    const interval = this.opts.rosterIntervalMs ?? 5_000;
    this.rosterTimer = setInterval(async () => {
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
        await this.writeRoster(entries, polledAt);
        await this.writeSquads(squads, polledAt);
      } catch (err) {
        // The full poll owns failure handling (teardown after three strikes);
        // a missed refresh only costs one frame of freshness.
        this.opts.log.debug(
          { err: (err as Error).message, serverId: this.target.serverId },
          'roster refresh failed',
        );
      } finally {
        this.pollInFlight = false;
      }
    }, interval);
  }

  private schedulePoll(): void {
    const interval = this.opts.pollIntervalMs ?? 30_000;
    this.pollTimer = setInterval(async () => {
      if (!this.client || this.pollInFlight) return;
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
        await upsertPlayers(this.opts.db, players, this.opts.geoLookup ?? null);
        const pollAt = new Date();
        await accruePlayerKitTime(
          this.opts.db,
          players,
          this.lastKitAccrualAt,
          pollAt,
          this.target.serverId,
          this.opts.pollIntervalMs ?? 30_000,
        );
        this.lastKitAccrualAt = pollAt;
        this.consecutivePollFails = 0;
        const polledAt = pollAt.toISOString();
        const { entries, firstSeen } = buildRoster(players, this.rosterFirstSeen, polledAt);
        this.rosterFirstSeen = firstSeen;
        await this.writeRoster(entries, polledAt);
        await this.writeSquads(squads, polledAt);
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
        await this.emitEvent('rcon.players_polled', {
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
        await this.writeStatus('connected', {
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
              await this.emitEvent('performance.degraded', {
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

        await this.tickSeeding(players.length, info?.map_name ?? null, polledAt);
      } catch (err) {
        this.consecutivePollFails += 1;
        const reason = (err as Error).message;
        this.opts.log.warn(
          { err: reason, serverId: this.target.serverId, fails: this.consecutivePollFails },
          'ListPlayers poll failed',
        );
        await this.writeStatus('connecting', {
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

      // A2S query — best-effort, does not affect RCON polling
      try {
        const a2sStart = Date.now();
        const a2sResult = await queryA2S(this.target.host, this.target.queryPort, 2000);
        const a2sKey = `a2s:status:${this.target.serverId}`;
        if (a2sResult) {
          await this.opts.redis.set(
            a2sKey,
            JSON.stringify({
              visible: a2sResult.visible,
              server_name: a2sResult.serverName,
              map: a2sResult.map,
              players: a2sResult.players,
              max_players: a2sResult.maxPlayers,
              latency_ms: Date.now() - a2sStart,
              queried_at: new Date().toISOString(),
            }),
            'EX',
            90,
          );
          this.consecutiveA2SFails = 0;
        } else {
          this.consecutiveA2SFails++;
          if (this.consecutiveA2SFails >= 3) {
            await this.opts.redis.set(
              a2sKey,
              JSON.stringify({
                visible: false,
                reason: 'timeout',
                queried_at: new Date().toISOString(),
              }),
              'EX',
              90,
            );
          }
        }
      } catch {
        // A2S is best-effort; don't disrupt RCON polling
      }
    }, interval);
  }

  private async emitDiag(args: {
    kind: string;
    severity: 'info' | 'warn' | 'error' | 'fatal';
    message: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.opts.diag) return;
    try {
      await this.opts.diag.emit({
        component: 'worker-rcon',
        kind: args.kind,
        severity: args.severity,
        serverId: this.target.serverId,
        message: args.message,
        payload: args.payload,
      });
    } catch {
      // diag is fire-and-forget; do not let telemetry derail the supervisor
    }
  }

  private async emitEvent(
    type: EventEnvelope['type'],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope: EventEnvelope = {
      event_id: uuidv7(),
      version: 1,
      type,
      server_id: this.target.serverId,
      ts: new Date().toISOString(),
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload,
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
      this.opts.log.warn({ err: (err as Error).message, type }, 'event publish failed');
    }
  }
}

// Declare the group constant is referenced so the tree-shaker doesn't drop it.
export const _consumerGroup = CONSUMER_GROUP;
