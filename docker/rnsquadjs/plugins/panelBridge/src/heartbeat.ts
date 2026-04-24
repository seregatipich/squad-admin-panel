import type { Redis } from 'ioredis';

export class Heartbeat {
  private timer?: NodeJS.Timeout;

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
    await this.redis.set(
      `worker:heartbeat:rnsquadjs:${this.serverId}`,
      new Date().toISOString(),
      'EX',
      30,
    );
  }
}
