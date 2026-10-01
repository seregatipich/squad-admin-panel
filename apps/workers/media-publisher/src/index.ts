import { createWorkerLog, runWorker } from '@squad/worker-kit';
import { createMediaPublisherDeps } from './deps.js';
import { runMediaPublisherTick } from './tick.js';

const log = createWorkerLog('media-publisher');

/**
 * Reads an integer environment variable within `[min, max]`, exiting on a
 * malformed value: a typo would otherwise become NaN and spin the tick loop
 * (`setInterval(fn, NaN)` fires every millisecond) or break the claim query.
 */
function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    log.fatal(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

/**
 * Poll interval for the publication queue. A minute is deliberate: publishing
 * is a showcase side-channel, uploads take far longer than the interval, and
 * both destinations meter their APIs.
 */
const TICK_INTERVAL_MS = integerEnv('MEDIA_PUBLISHER_INTERVAL_MS', 60_000, 1_000, 3_600_000);
/** Publications handled per tick — bounded so one large upload cannot stall the loop indefinitely. */
const BATCH_SIZE = integerEnv('MEDIA_PUBLISHER_BATCH_SIZE', 3, 1, 50);

runWorker({
  name: 'media-publisher',
  log,
  entrypoint: import.meta.url,
  postgres: { drizzle: true },
  setup: ({ db, diag }) => {
    const runtimeDeps = createMediaPublisherDeps(db, {
      mediaBaseDir: process.env.MEDIA_STORAGE_DIR ?? './media',
      env: {
        YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
        YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
        YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      },
    });
    return {
      startedPayload: {
        pid: process.pid,
        // Presence only — a credential value must never reach a log or diag event.
        youtube_configured: Boolean(runtimeDeps.publishers.youtube),
        telegram_configured: Boolean(runtimeDeps.publishers.telegram),
      },
      ticks: [
        {
          intervalMs: TICK_INTERVAL_MS,
          // Uploads are known to run longer than the poll interval, so an interval
          // can fire while the previous pass is still running. Each overlapping pass
          // would claim its own `BATCH_SIZE` more rows and hold its own in-memory
          // reads (`youtube.ts`'s `readMedia`, up to 2 GiB), risking unbounded
          // concurrent memory use under a slow destination (#63 finding 943).
          overlap: { warn: 'media-publisher tick skipped: previous tick still in flight' },
          failureMessage: 'media-publisher tick failed',
          firstRunFailure: 'log',
          run: async () => {
            const result = await runMediaPublisherTick({
              ...runtimeDeps,
              diag,
              batchSize: BATCH_SIZE,
            });
            if (result.claimed > 0) log.info(result, 'media-publisher tick');
          },
        },
      ],
    };
  },
});
