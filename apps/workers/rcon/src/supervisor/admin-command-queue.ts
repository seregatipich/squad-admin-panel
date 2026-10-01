import type Redis from 'ioredis';
import type { RconClient } from '../client.js';
import { RconCommandQueue } from '../commands.js';
import type { SupervisorOptions, Target } from './types.js';

/**
 * The Redis Stream command queue of one server, tied to its current RCON
 * connection: started once the connection is authenticated and stopped,
 * together with its own Redis connection, when it goes away.
 */
export class AdminCommandQueue {
  private commandQueue?: RconCommandQueue;
  /** Dedicated connection for {@link commandQueue}; see {@link start}. */
  private commandRedis?: Redis;

  /** `getClient` is read on every command, so the queue always executes on the live connection. */
  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
    private readonly getClient: () => RconClient | undefined,
  ) {}

  async start(): Promise<void> {
    if (this.commandQueue || !this.getClient()) return;
    // The queue parks on `XREADGROUP BLOCK`, which holds its connection for
    // the whole block window. On the shared connection every status, roster
    // and live-bus write queued behind it for up to that long, so the panel
    // saw each change half a second late per server. It gets its own.
    const connection =
      typeof this.opts.redis.duplicate === 'function' ? this.opts.redis.duplicate() : null;
    connection?.on('error', (err: Error) =>
      this.opts.log.warn(
        { err: err.message, serverId: this.target.serverId },
        'rcon command queue redis error',
      ),
    );
    this.commandRedis = connection ?? undefined;
    const queue = new RconCommandQueue({
      redis: connection ?? this.opts.redis,
      log: this.opts.log.child({
        serverId: this.target.serverId,
        component: 'rcon-command-queue',
      }),
      serverId: this.target.serverId,
      execute: async (command) => {
        const client = this.getClient();
        if (!client) throw new Error('rcon not connected');
        return await client.exec(command);
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
      this.commandRedis?.disconnect();
      this.commandRedis = undefined;
    }
  }

  async stop(): Promise<void> {
    const queue = this.commandQueue;
    this.commandQueue = undefined;
    await queue?.stop();
    const connection = this.commandRedis;
    this.commandRedis = undefined;
    connection?.disconnect();
  }
}
