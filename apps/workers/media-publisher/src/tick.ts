import type { Diag } from '@squad/diag';

export type MediaPublicationDestination = 'youtube' | 'telegram';

/** Base delay before the first retry. Doubles per attempt, capped below. */
export const MEDIA_PUBLISH_BACKOFF_BASE_MS = 60_000;
/** Ceiling on the retry delay — six hours, so a long outage still self-heals same-day. */
export const MEDIA_PUBLISH_BACKOFF_MAX_MS = 6 * 3_600_000;
/** How many ordinary failures a publication absorbs before it is declared dead. */
export const MEDIA_PUBLISH_MAX_ATTEMPTS = 8;
/** How long a publication waits when its destination has no credentials at all. */
export const MEDIA_PUBLISH_UNCONFIGURED_DELAY_MS = 3_600_000;

/** One claimed row of `media_publications`, joined with the media it publishes. */
export interface MediaPublicationJob {
  id: string;
  mediaId: string;
  destination: MediaPublicationDestination;
  attempts: number;
  storagePath: string | null;
  mimeType: string;
  sizeBytes: number;
  title: string | null;
  description: string | null;
  originalFilename: string;
}

/**
 * What a destination reports back.
 *
 * `quota: true` is a third outcome beside success and failure, not a flavour of
 * failure: a daily-quota wall is outside our control, so it must never advance
 * the attempt counter or reach `failed`. `externalUrl` is nullable on success
 * because a Telegram message is not always publicly addressable.
 */
export type PublishOutcome =
  | { ok: true; externalId: string; externalUrl: string | null }
  | {
      ok: false;
      retryable: boolean;
      error: string;
      quota?: boolean;
      retryAfterMs?: number;
    };

export type MediaPublisher = (job: MediaPublicationJob) => Promise<PublishOutcome>;

export interface MediaPublisherTickDeps {
  now?: Date;
  batchSize?: number;
  /** Atomically claims due publications, flipping them to `uploading`. */
  claimDue(now: Date, limit: number): Promise<MediaPublicationJob[]>;
  /** Only destinations with credentials are present; the rest are deferred, not failed. */
  publishers: Partial<Record<MediaPublicationDestination, MediaPublisher>>;
  markPublished(
    id: string,
    result: { externalId: string; externalUrl: string | null },
    now: Date,
  ): Promise<void>;
  markRetry(
    id: string,
    patch: { attempts: number; error: string; nextAttemptAt: Date },
  ): Promise<void>;
  markFailed(id: string, error: string, attempts: number): Promise<void>;
  deferUnconfigured(id: string, nextAttemptAt: Date): Promise<void>;
  /** Applies the "free the disk after publishing" setting; returns whether it fired. */
  releaseIfEnabled(job: MediaPublicationJob, externalUrl: string | null): Promise<boolean>;
  diag: Pick<Diag, 'emit'>;
}

export interface MediaPublisherTickResult {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  skipped: number;
  released: number;
}

const DEFAULT_BATCH_SIZE = 5;

/** Exponential backoff for `attempts` consecutive failures, clamped to the ceiling. */
export function computeBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // Guard the shift itself: 2 ** 1024 is Infinity, and Infinity * base is NaN
  // under some engines' fast paths. Clamp before multiplying.
  if (exponent > 40) return MEDIA_PUBLISH_BACKOFF_MAX_MS;
  return Math.min(MEDIA_PUBLISH_BACKOFF_BASE_MS * 2 ** exponent, MEDIA_PUBLISH_BACKOFF_MAX_MS);
}

/**
 * One pass of the publication queue: claim what is due, hand each job to its
 * destination, and record the outcome.
 *
 * Every job is isolated — a destination that throws is recorded as a retryable
 * error for that job alone and never aborts the batch.
 */
export async function runMediaPublisherTick(
  deps: MediaPublisherTickDeps,
): Promise<MediaPublisherTickResult> {
  const now = deps.now ?? new Date();
  const jobs = await deps.claimDue(now, deps.batchSize ?? DEFAULT_BATCH_SIZE);

  const result: MediaPublisherTickResult = {
    claimed: jobs.length,
    published: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    released: 0,
  };

  for (const job of jobs) {
    const publisher = deps.publishers[job.destination];
    if (!publisher) {
      const nextAttemptAt = new Date(now.getTime() + MEDIA_PUBLISH_UNCONFIGURED_DELAY_MS);
      await deps.deferUnconfigured(job.id, nextAttemptAt);
      result.skipped += 1;
      await deps.diag.emit({
        component: 'worker-media-publisher',
        kind: 'media_publish.skipped',
        severity: 'info',
        message: `${job.destination} is not configured; deferring publication`,
        payload: { publication_id: job.id, destination: job.destination },
      });
      continue;
    }

    let outcome: PublishOutcome;
    try {
      outcome = await publisher(job);
    } catch (err) {
      outcome = { ok: false, retryable: true, error: `publisher_threw: ${(err as Error).message}` };
    }

    if (outcome.ok) {
      await deps.markPublished(
        job.id,
        { externalId: outcome.externalId, externalUrl: outcome.externalUrl },
        now,
      );
      result.published += 1;
      if (await deps.releaseIfEnabled(job, outcome.externalUrl)) result.released += 1;
      await deps.diag.emit({
        component: 'worker-media-publisher',
        kind: 'media_publish.published',
        severity: 'info',
        message: `published media ${job.mediaId} to ${job.destination}`,
        payload: {
          publication_id: job.id,
          media_id: job.mediaId,
          destination: job.destination,
          external_id: outcome.externalId,
        },
      });
      continue;
    }

    if (outcome.quota) {
      // Quota is a wall, not a fault: hold the attempt counter and wait out the
      // window. The row stays `queued`, which is what the UI shows as retrying.
      const nextAttemptAt = new Date(
        now.getTime() + (outcome.retryAfterMs ?? computeBackoffMs(job.attempts + 1)),
      );
      await deps.markRetry(job.id, { attempts: job.attempts, error: outcome.error, nextAttemptAt });
      result.retried += 1;
      await deps.diag.emit({
        component: 'worker-media-publisher',
        kind: 'media_publish.retry',
        severity: 'warn',
        message: `${job.destination} quota reached; deferring publication`,
        payload: {
          publication_id: job.id,
          destination: job.destination,
          error: outcome.error,
          next_attempt_at: nextAttemptAt.toISOString(),
          quota: true,
        },
      });
      continue;
    }

    const attempts = job.attempts + 1;
    if (!outcome.retryable || attempts >= MEDIA_PUBLISH_MAX_ATTEMPTS) {
      await deps.markFailed(job.id, outcome.error, attempts);
      result.failed += 1;
      await deps.diag.emit({
        component: 'worker-media-publisher',
        kind: 'media_publish.failed',
        severity: 'error',
        message: `publication to ${job.destination} failed permanently`,
        payload: {
          publication_id: job.id,
          destination: job.destination,
          error: outcome.error,
          attempts,
        },
      });
      continue;
    }

    const nextAttemptAt = new Date(
      now.getTime() + (outcome.retryAfterMs ?? computeBackoffMs(attempts)),
    );
    await deps.markRetry(job.id, { attempts, error: outcome.error, nextAttemptAt });
    result.retried += 1;
    await deps.diag.emit({
      component: 'worker-media-publisher',
      kind: 'media_publish.retry',
      severity: 'warn',
      message: `publication to ${job.destination} will be retried`,
      payload: {
        publication_id: job.id,
        destination: job.destination,
        error: outcome.error,
        attempts,
        next_attempt_at: nextAttemptAt.toISOString(),
      },
    });
  }

  return result;
}
