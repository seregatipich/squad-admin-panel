import type { DatabaseClient } from '@squad/db';
import { CONSUMER_GROUP, type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { RconClient } from './client.js';
import { parseListPlayers } from './parse-list-players.js';
import { upsertPlayers } from './persist.js';

export interface Target {
  serverId: string;
  host: string;
  port: number;
  password: string;
}

export interface SupervisorOptions {
  db: DatabaseClient;
  redis: Redis;
  log: Logger;
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
    for (const [id, t] of incoming) {
      if (!this.supervisors.has(id)) {
        const sup = new PerServerSupervisor(t, this.opts);
        this.supervisors.set(id, sup);
        this.targets.set(id, t);
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
      }
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
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.writeStatus('connecting', { backoffMs: this.backoffMs });
        this.client = new RconClient({
          host: this.target.host,
          port: this.target.port,
          password: this.target.password,
          log: this.opts.log.child({ serverId: this.target.serverId }),
        });
        await this.client.connect();
        this.opts.log.info({ serverId: this.target.serverId }, 'rcon connected');
        this.backoffMs = this.opts.initialBackoffMs ?? 1000;
        await this.emitEvent('rcon.connected', {});
        await this.writeStatus('connected');
        this.schedulePoll();
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (this.stopped || !this.client) {
              clearInterval(check);
              resolve();
            }
          }, 1000);
        });
      } catch (err) {
        this.opts.log.warn(
          {
            err: (err as Error).message,
            serverId: this.target.serverId,
            backoffMs: this.backoffMs,
          },
          'rcon connect failed',
        );
      } finally {
        if (this.pollTimer) clearInterval(this.pollTimer);
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        await this.emitEvent('rcon.disconnected', {});
      }
      if (!this.stopped) {
        // Stay in 'connecting' (not 'disconnected') during backoff so the
        // panel UI shows the amber dot continuously instead of flashing red
        // between retries. Retry attempts are expected transient.
        await this.writeStatus('connecting', {
          backoffMs: this.backoffMs,
          reason: 'reconnect-backoff',
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
        const raw = await this.client.exec('ListPlayers');
        const players = parseListPlayers(raw);
        await upsertPlayers(this.opts.db, players);
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
        // Refresh rcon:status key on every poll so the API's /servers list
        // can surface an always-current player count + connection state.
        await this.writeStatus('connected', {
          player_count: players.length,
          last_poll_at: new Date().toISOString(),
        });
      } catch (err) {
        this.opts.log.warn(
          { err: (err as Error).message, serverId: this.target.serverId },
          'ListPlayers poll failed',
        );
      }
    }, interval);
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
