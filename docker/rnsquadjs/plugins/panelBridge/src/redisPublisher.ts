import type { Redis } from 'ioredis';
import type { EventEnvelope } from './eventMap.js';

export type Mode = 'production' | 'shadow';

export interface RconStatus {
  state: 'connected' | 'disconnected';
  lastChange: string;
}

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
    await this.redis.xadd(this.eventStream(), '*', 'envelope', JSON.stringify(envelope));
  }

  async publishRconStatus(status: RconStatus): Promise<void> {
    await this.redis.set(this.statusKey(), JSON.stringify(status), 'EX', 300);
  }
}
