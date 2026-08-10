import type { DatabaseClient } from '@squad/db';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { registerApplicationCommands } from './command-registration.js';
import { loadDiscordBotContext } from './role-sync.js';
import { runStatusChannelTick, type StatusChannelTickSummary } from './status-channel.js';

/**
 * DISCORD-6 (#153): drives the status-channel rename tick, and registers the
 * slash commands once the bot credentials are available.
 *
 * Like the role sync (#152), the loop is gated on `loadDiscordBotContext`
 * returning non-null: until an operator has stored a guild id and a bot token
 * the loop ticks, finds nothing to do and sleeps. Credentials are re-read every
 * cycle so configuring the bot takes effect without a restart.
 *
 * The default interval is ten minutes, matching the window Discord meters
 * channel renames over — see `status-channel.ts` for the budget itself.
 */
export const DEFAULT_STATUS_CHANNEL_TICK_MS = 600_000;

export interface StatusChannelLoopOpts {
  db: DatabaseClient;
  redis: Redis;
  encryptionKey: Buffer;
  fetchImpl: typeof fetch;
  /**
   * Waits out the gap between ticks. The interval is ten minutes, so a
   * production caller must pass a sleep that resolves early on shutdown
   * (`index.ts` aborts it from the signal handler) — the loop itself only
   * consults `shouldStop` once per cycle and would otherwise hold shutdown open
   * for a whole interval.
   */
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  shouldStop: () => boolean;
  tickIntervalMs?: number;
  /**
   * Discord application id. Slash commands are registered only when it is set;
   * the status channel works without it.
   */
  applicationId?: string | null;
  /** Injected so tests can drive the rename window without real time. */
  now?: () => number;
}

export async function runStatusChannelLoop(opts: StatusChannelLoopOpts): Promise<void> {
  const intervalMs =
    opts.tickIntervalMs && opts.tickIntervalMs > 0
      ? opts.tickIntervalMs
      : DEFAULT_STATUS_CHANNEL_TICK_MS;
  let commandsRegistered = false;

  while (!opts.shouldStop()) {
    try {
      const ctx = await loadDiscordBotContext(opts.db, opts.encryptionKey);
      if (ctx) {
        const deps = {
          db: opts.db,
          redis: opts.redis,
          guildId: ctx.guildId,
          botToken: ctx.botToken,
          fetchImpl: opts.fetchImpl,
          sleep: opts.sleep,
          log: opts.log,
          now: opts.now ?? Date.now,
        };

        if (!commandsRegistered && opts.applicationId) {
          const result = await registerApplicationCommands(deps, opts.applicationId);
          if (result.ok) {
            commandsRegistered = true;
            opts.log.info({ count: result.count }, 'discord slash commands registered');
          } else {
            opts.log.warn(
              { status: result.status, message: result.message },
              'discord slash command registration failed; will retry next tick',
            );
          }
        }

        const summary: StatusChannelTickSummary = await runStatusChannelTick(deps);
        if (summary.renamed > 0 || summary.errors > 0 || summary.rateLimited > 0) {
          opts.log.info({ ...summary }, 'discord status channel tick');
        }
      }
    } catch (err) {
      opts.log.error({ err: (err as Error).message }, 'discord status channel tick failed');
    }
    await opts.sleep(intervalMs);
  }
}
