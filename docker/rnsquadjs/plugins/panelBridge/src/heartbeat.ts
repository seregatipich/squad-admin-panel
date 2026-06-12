import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly redis: Redis,
    private readonly serverId: string,
    private readonly intervalMs = 10_000,
  ) {}

  start(): void {
    this.stopped = false;
    void this.runTick();
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runTick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (err) {
      console.error('panelBridge heartbeat tick', err);
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
