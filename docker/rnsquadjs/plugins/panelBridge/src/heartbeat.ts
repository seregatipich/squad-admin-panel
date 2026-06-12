import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly redis: Redis,
    private readonly serverId: string,
    private readonly intervalMs = 10_000,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const payload = {
      name: `rnsquadjs:${this.serverId}`,
      ts: new Date().toISOString(),
      pid: process.pid,
      hostname: hostname(),
      version: process.env.UPSTREAM_SHA ?? 'unknown',
      started_at: this.startedAt,
      status: 'ok',
    };
    await this.redis.set(
      `worker:heartbeat:rnsquadjs:${this.serverId}`,
      JSON.stringify(payload),
      'EX',
      30,
    );
  }
}
