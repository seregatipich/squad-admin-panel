import { BAN_SYNC_MANUAL_STREAM } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { SyncReport } from './sync-source.js';
import { type DueSource, syncExclusively } from './tick.js';

/** Stream the API's `POST /api/v1/ban-sources/:id/sync` appends manual sync jobs to. */
export const MANUAL_STREAM = BAN_SYNC_MANUAL_STREAM;
/** Consumer group every ban-sync process shares on {@link MANUAL_STREAM}. */
export const MANUAL_GROUP = 'ban-sync';

interface ManualJob {
  source_id?: string;
  actor_player_id?: string | null;
  request_id?: string;
  enqueued_at?: string;
}

export interface ManualQueueDeps {
  /** Connection used for XGROUP and XACK. */
  redis: Pick<Redis, 'xgroup' | 'xack'>;
  /**
   * Connection dedicated to the blocking XREADGROUP, so heartbeat and diag
   * writes never queue behind it and shutdown can end the read by closing it.
   */
  readRedis: Pick<Redis, 'xreadgroup'>;
  consumer: string;
  blockMs: number;
  loadSource: (sourceId: string) => Promise<DueSource | null>;
  syncOne: (source: DueSource) => Promise<SyncReport>;
  /** Sources being synced right now, shared with the scheduled tick (#853). */
  inFlight: Set<string>;
  /** Called after a manual sync ran, e.g. to clear the source's backoff. */
  onSynced?: (source: DueSource, report: SyncReport) => void;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  shouldStop: () => boolean;
  /** Pause after a failed read or group creation; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseJob(fields: string[]): ManualJob | null {
  const idx = fields.indexOf('job');
  const raw = idx >= 0 ? fields[idx + 1] : undefined;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ManualJob;
  } catch {
    return null;
  }
}

async function runJob(deps: ManualQueueDeps, entryId: string, fields: string[]): Promise<void> {
  const job = parseJob(fields);
  if (!job?.source_id) {
    deps.log.warn({ entryId }, 'malformed bansync:manual job; acked without a sync');
    return;
  }
  const source = await deps.loadSource(job.source_id);
  if (!source) {
    deps.log.warn({ sourceId: job.source_id }, 'manual sync requested for unknown source');
    return;
  }
  // Manual sync bypasses the due-time check and the in-memory backoff map —
  // but never runs next to a sync of the same source already under way,
  // which would race it on the same rows.
  const report = await syncExclusively(deps.inFlight, source, deps.syncOne);
  if (!report) {
    deps.log.info({ sourceId: source.id }, 'manual ban-sync skipped: source already syncing');
    return;
  }
  deps.onSynced?.(source, report);
  deps.log.info({ sourceId: source.id, ...report }, 'manual ban-sync');
}

/**
 * Runs one job and acknowledges it whatever the outcome: a failed manual sync
 * is recorded on the source like any other, and the scheduled tick retries
 * the source, so redelivering the job would add nothing.
 */
async function handleEntry(deps: ManualQueueDeps, entryId: string, fields: string[]) {
  try {
    await runJob(deps, entryId, fields);
  } catch (err) {
    deps.log.error({ err: (err as Error).message, entryId }, 'manual ban-sync failed');
  }
  await deps.redis.xack(MANUAL_STREAM, MANUAL_GROUP, entryId);
}

/**
 * Consumes manual sync jobs from {@link MANUAL_STREAM} until `shouldStop`.
 *
 * Nothing inside it rejects the loop (#1292): group creation is retried until
 * it succeeds (and redone after a `NOGROUP` read error), a failing read is
 * retried after a pause, and a job whose sync or XACK fails is logged while
 * the loop moves on to the next one.
 */
export async function runManualQueueLoop(deps: ManualQueueDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  let groupReady = false;

  while (!deps.shouldStop()) {
    if (!groupReady) {
      try {
        await deps.redis
          .xgroup('CREATE', MANUAL_STREAM, MANUAL_GROUP, '$', 'MKSTREAM')
          .catch((err: Error) => {
            if (!String(err.message).includes('BUSYGROUP')) throw err;
          });
        groupReady = true;
      } catch (err) {
        deps.log.error({ err: (err as Error).message }, 'manual-queue group creation failed');
        await sleep(1000);
        continue;
      }
    }

    let result: [string, [string, string[]][]][] | null;
    try {
      result = (await deps.readRedis.xreadgroup(
        'GROUP',
        MANUAL_GROUP,
        deps.consumer,
        'BLOCK',
        deps.blockMs,
        'STREAMS',
        MANUAL_STREAM,
        '>',
      )) as [string, [string, string[]][]][] | null;
    } catch (err) {
      // Shutdown closed the connection under the blocked read.
      if (deps.shouldStop()) return;
      const message = (err as Error).message;
      deps.log.warn({ err: message }, 'manual-queue xreadgroup failed');
      if (message.includes('NOGROUP')) groupReady = false;
      await sleep(1000);
      continue;
    }

    for (const [, entries] of result ?? []) {
      for (const [entryId, fields] of entries) {
        try {
          await handleEntry(deps, entryId, fields);
        } catch (err) {
          deps.log.error(
            { err: (err as Error).message, entryId },
            'manual ban-sync job could not be acknowledged; left pending',
          );
        }
      }
    }
  }
}
