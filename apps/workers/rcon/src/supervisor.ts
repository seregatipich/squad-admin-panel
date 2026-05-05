import type { DatabaseClient } from '@squad/db';
import type { Diag } from '@squad/diag';
import { CONSUMER_GROUP, type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { queryA2S } from './a2s.js';
import { RconClient } from './client.js';
import { parseListPlayers } from './parse-list-players.js';
import { parseServerInfo } from './parse-server-info.js';
import { upsertPlayers } from './persist.js';

export interface Target {
  serverId: string;
  host: string;
  port: number;
  queryPort: number;
  tickrate?: number;
  password: string;
}

export interface SupervisorOptions {
  db: DatabaseClient;
  redis: Redis;
  log: Logger;
  diag?: Diag;
  pollIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class RconSupervisor {
  private readonly targets = new Map<string, Target>();
  private readonly supervisors = new Map<string, PerServerSupervisor>();

  constructor(private readonly opts: SupervisorOptions) {}

  async reconcile(targets: Target[]): Promise<void> {
    const incoming = new Map(targets.map((t) => [t.serverId, t]));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [id, t] of incoming) {
      if (!this.supervisors.has(id)) {
        const sup = new PerServerSupervisor(t, this.opts);
        this.supervisors.set(id, sup);
        this.targets.set(id, t);
        added.push(id);
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
    if ((added.length || removed.length) && this.opts.diag) {
      const total = this.supervisors.size;
      this.opts.diag
        .emit({
          component: 'worker-rcon',
          kind: 'rcon.targets.changed',
          severity: 'info',
          message: `targets changed: +${added.length}, -${removed.length}, total=${total}`,
          payload: { added, removed, total },
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
  private backoffMs: number;
  private onDisconnect?: () => void;
  private consecutivePollFails = 0;
  private consecutiveA2SFails = 0;
  private consecutiveLowTick = 0;

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {
    this.backoffMs = opts.initialBackoffMs ?? 1000;
  }

  async start(): Promise<void> {
    this.connectLoop().catch((err) =>
      this.opts.log.error(
        { err: (err as Error).message, serverId: this.target.serverId },
        'supervisor failed',
      ),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
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
        await this.emitEvent('rcon.connected', {});
        await this.emitDiag({
          kind: 'rcon.connected',
          severity: 'info',
          message: `rcon connected ${this.target.host}:${this.target.port}`,
          payload: { host: this.target.host, port: this.target.port },
        });
        await this.writeStatus('connected');
        this.schedulePoll();
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
        if (this.pollTimer) clearInterval(this.pollTimer);
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

  private schedulePoll(): void {
    const interval = this.opts.pollIntervalMs ?? 30_000;
    this.pollTimer = setInterval(async () => {
      if (!this.client) return;
      try {
        const start = Date.now();
        const rawPlayers = await this.client.exec('ListPlayers');
        const rawInfo = await this.client.exec('ShowServerInfo').catch(() => '');
        const players = parseListPlayers(rawPlayers);
        const info = rawInfo ? parseServerInfo(rawInfo) : null;
        await upsertPlayers(this.opts.db, players);
        this.consecutivePollFails = 0;
        const pollMs = Date.now() - start;
        this.opts.log.info(
          {
            serverId: this.target.serverId,
            ms: pollMs,
            n: players.length,
          },
          'poll listplayers',
        );
        await this.emitEvent('rcon.players_polled', {
          players: players.map((p) => ({
            steam_id64: p.steam_id64,
            eos_id: p.eos_id,
            name: p.name,
            team_id: p.team_id,
            squad_id: p.squad_id,
            is_leader: p.is_leader ?? false,
            role: p.role ?? undefined,
          })),
          polled_at: new Date().toISOString(),
          latency_ms: Date.now() - start,
        });
        await this.writeStatus('connected', {
          player_count: players.length,
          last_poll_at: new Date().toISOString(),
          tickrate_rt: info?.tickrate ?? undefined,
          current_map: info?.map_name ?? undefined,
          next_layer: info?.next_layer ?? undefined,
          game_mode: info?.game_mode ?? undefined,
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
