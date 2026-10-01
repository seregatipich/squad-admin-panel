import type { Redis } from 'ioredis';
import type { EventEnvelope } from './eventMap';

export type Mode = 'production' | 'shadow';

export interface RconStatus {
  state: 'connected' | 'disconnected';
  lastChange: string;
}

/**
 * Approximate cap (`XADD MAXLEN ~`) on the per-server event stream, matching
 * the legacy `worker-log-ingest` producer. Nothing else trims the shadow
 * stream (no repository consumer reads it), so without this cap every
 * damage/chat event would grow Redis memory forever (#16).
 */
export const EVENT_STREAM_MAXLEN = '10000';

/**
 * TTL of the `rnsquadjs:status:{id}[:shadow]` key. `startPanelBridge` rewrites
 * the key every 10 s, so it lapses only when the sidecar itself is gone.
 */
export const STATUS_TTL_SECONDS = 300;

export class RedisPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly serverId: string,
    private readonly mode: Mode,
  ) {}

  private suffix(): string {
    return this.mode === 'shadow' ? ':shadow' : '';
  }

  private eventStream(): string {
    return `events:server:${this.serverId}${this.suffix()}`;
  }

  private statusKey(): string {
    // D4: worker-rcon owns the legacy per-server status key; the sidecar
    // publishes under its own prefix and must never clobber the worker's.
    return `rnsquadjs:status:${this.serverId}${this.suffix()}`;
  }

  async publishEvent(envelope: EventEnvelope): Promise<void> {
    await this.redis.xadd(
      this.eventStream(),
      'MAXLEN',
      '~',
      EVENT_STREAM_MAXLEN,
      '*',
      'envelope',
      JSON.stringify(envelope),
    );
  }

  async publishRconStatus(status: RconStatus): Promise<void> {
    await this.redis.set(this.statusKey(), JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);
  }
}
