import { describe, expect, it, vi } from 'vitest';
import {
  computeBackoffMs,
  MEDIA_PUBLISH_BACKOFF_BASE_MS,
  MEDIA_PUBLISH_BACKOFF_MAX_MS,
  MEDIA_PUBLISH_MAX_ATTEMPTS,
  type MediaPublicationJob,
  type MediaPublisherTickDeps,
  type PublishOutcome,
  runMediaPublisherTick,
} from '../src/tick.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function makeJob(overrides: Partial<MediaPublicationJob> = {}): MediaPublicationJob {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    mediaId: '018f0000-0000-7000-8000-0000000000aa',
    destination: 'telegram',
    attempts: 0,
    storagePath: '2026/07/clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1024,
    title: 'Клип',
    description: null,
    originalFilename: 'clip.mp4',
    ...overrides,
  };
}

interface RecordedDeps extends MediaPublisherTickDeps {
  markPublished: ReturnType<typeof vi.fn>;
  markRetry: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  deferUnconfigured: ReturnType<typeof vi.fn>;
  releaseIfEnabled: ReturnType<typeof vi.fn>;
  emitted: { kind: string; payload?: Record<string, unknown> }[];
}

function makeDeps(
  jobs: MediaPublicationJob[],
  publishers: MediaPublisherTickDeps['publishers'],
  overrides: Partial<MediaPublisherTickDeps> = {},
): RecordedDeps {
  const emitted: { kind: string; payload?: Record<string, unknown> }[] = [];
  return {
    now: NOW,
    claimDue: vi.fn(async () => jobs),
    publishers,
    markPublished: vi.fn(async () => undefined),
    markRetry: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    deferUnconfigured: vi.fn(async () => undefined),
    releaseIfEnabled: vi.fn(async () => false),
    diag: {
      emit: async (ev) => {
        emitted.push({ kind: ev.kind, payload: ev.payload as Record<string, unknown> });
      },
    },
    emitted,
    ...overrides,
  } as RecordedDeps;
}

const success: PublishOutcome = {
  ok: true,
  externalId: 'vid-1',
  externalUrl: 'https://t.me/c/1234/9',
};

describe('runMediaPublisherTick', () => {
  it('moves a claimed job to published and records the external id and url', async () => {
    const job = makeJob();
    const deps = makeDeps([job], { telegram: async () => success });

    const result = await runMediaPublisherTick(deps);

    expect(result).toMatchObject({ claimed: 1, published: 1, retried: 0, failed: 0, skipped: 0 });
    expect(deps.markPublished).toHaveBeenCalledWith(
      job.id,
      { externalId: 'vid-1', externalUrl: 'https://t.me/c/1234/9' },
      NOW,
    );
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.markRetry).not.toHaveBeenCalled();
    expect(deps.emitted.map((e) => e.kind)).toContain('media_publish.published');
  });

  it('keeps a YouTube quota error in retry instead of failing it, and honours retryAfterMs', async () => {
    const job = makeJob({ destination: 'youtube', attempts: 3 });
    const retryAfterMs = 7 * 3_600_000;
    const deps = makeDeps([job], {
      youtube: async () => ({
        ok: false,
        retryable: true,
        quota: true,
        error: 'quota_exceeded',
        retryAfterMs,
      }),
    });

    const result = await runMediaPublisherTick(deps);

    expect(result).toMatchObject({ claimed: 1, published: 0, retried: 1, failed: 0 });
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.markRetry).toHaveBeenCalledTimes(1);
    const patch = deps.markRetry.mock.calls[0]?.[1];
    expect(patch.error).toBe('quota_exceeded');
    // A quota wall is not the job's fault: the attempt counter must not advance,
    // otherwise a long outage would burn the job's retry budget and fail it.
    expect(patch.attempts).toBe(3);
    expect(patch.nextAttemptAt.getTime()).toBe(NOW.getTime() + retryAfterMs);
    expect(patch.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('never fails a quota-blocked job even past the max attempt budget', async () => {
    const job = makeJob({ destination: 'youtube', attempts: MEDIA_PUBLISH_MAX_ATTEMPTS + 5 });
    const deps = makeDeps([job], {
      youtube: async () => ({
        ok: false,
        retryable: true,
        quota: true,
        error: 'quota_exceeded',
        retryAfterMs: 1_000,
      }),
    });

    const result = await runMediaPublisherTick(deps);

    expect(result.failed).toBe(0);
    expect(result.retried).toBe(1);
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it('increments attempts and backs off exponentially on an ordinary retryable error', async () => {
    const job = makeJob({ attempts: 2 });
    const deps = makeDeps([job], {
      telegram: async () => ({ ok: false, retryable: true, error: 'telegram_5xx' }),
    });

    await runMediaPublisherTick(deps);

    const patch = deps.markRetry.mock.calls[0]?.[1];
    expect(patch.attempts).toBe(3);
    expect(patch.error).toBe('telegram_5xx');
    expect(patch.nextAttemptAt.getTime()).toBe(NOW.getTime() + computeBackoffMs(3));
  });

  it('fails a job permanently once the retry budget is exhausted', async () => {
    const job = makeJob({ attempts: MEDIA_PUBLISH_MAX_ATTEMPTS - 1 });
    const deps = makeDeps([job], {
      telegram: async () => ({ ok: false, retryable: true, error: 'telegram_5xx' }),
    });

    const result = await runMediaPublisherTick(deps);

    expect(result).toMatchObject({ failed: 1, retried: 0, published: 0 });
    expect(deps.markFailed).toHaveBeenCalledWith(
      job.id,
      'telegram_5xx',
      MEDIA_PUBLISH_MAX_ATTEMPTS,
    );
    expect(deps.markRetry).not.toHaveBeenCalled();
  });

  it('fails a non-retryable error immediately without consuming further attempts', async () => {
    const job = makeJob();
    const deps = makeDeps([job], {
      telegram: async () => ({ ok: false, retryable: false, error: 'telegram_file_too_large' }),
    });

    const result = await runMediaPublisherTick(deps);

    expect(result).toMatchObject({ failed: 1, retried: 0 });
    expect(deps.markFailed).toHaveBeenCalledWith(job.id, 'telegram_file_too_large', 1);
    expect(deps.emitted.map((e) => e.kind)).toContain('media_publish.failed');
  });

  it('defers a job whose destination has no credentials instead of failing it', async () => {
    const job = makeJob({ destination: 'youtube' });
    const deps = makeDeps([job], { telegram: async () => success });

    const result = await runMediaPublisherTick(deps);

    expect(result).toMatchObject({ skipped: 1, failed: 0, retried: 0, published: 0 });
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.deferUnconfigured).toHaveBeenCalledTimes(1);
    const [id, nextAttemptAt] = deps.deferUnconfigured.mock.calls[0] ?? [];
    expect(id).toBe(job.id);
    expect(nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(deps.emitted.map((e) => e.kind)).toContain('media_publish.skipped');
  });

  it('treats a publisher that throws as a retryable error rather than crashing the tick', async () => {
    const job = makeJob();
    const deps = makeDeps([job], {
      telegram: async () => {
        throw new Error('socket hang up');
      },
    });

    const result = await runMediaPublisherTick(deps);

    expect(result).toMatchObject({ retried: 1, failed: 0 });
    expect(deps.markRetry.mock.calls[0]?.[1].error).toContain('socket hang up');
  });

  it('asks to release the local file only after a successful publish', async () => {
    const job = makeJob();
    const deps = makeDeps([job], { telegram: async () => success });
    deps.releaseIfEnabled = vi.fn(async () => true);

    const result = await runMediaPublisherTick(deps);

    expect(deps.releaseIfEnabled).toHaveBeenCalledWith(job, success.externalUrl);
    expect(result.released).toBe(1);
  });

  it('does not attempt to release the local file when the publish failed', async () => {
    const job = makeJob();
    const deps = makeDeps([job], {
      telegram: async () => ({ ok: false, retryable: false, error: 'nope' }),
    });

    const result = await runMediaPublisherTick(deps);

    expect(deps.releaseIfEnabled).not.toHaveBeenCalled();
    expect(result.released).toBe(0);
  });

  it('processes every claimed job independently', async () => {
    const good = makeJob({ id: '018f0000-0000-7000-8000-000000000001' });
    const bad = makeJob({ id: '018f0000-0000-7000-8000-000000000002' });
    const deps = makeDeps([good, bad], {
      telegram: async (job) =>
        job.id === good.id ? success : { ok: false, retryable: false, error: 'nope' },
    });

    const result = await runMediaPublisherTick(deps);

    expect(result).toMatchObject({ claimed: 2, published: 1, failed: 1 });
  });

  it('returns an all-zero result when nothing is due', async () => {
    const deps = makeDeps([], { telegram: async () => success });

    const result = await runMediaPublisherTick(deps);

    expect(result).toEqual({
      claimed: 0,
      published: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      released: 0,
    });
  });
});

describe('computeBackoffMs', () => {
  it('starts at the base delay for the first attempt', () => {
    expect(computeBackoffMs(1)).toBe(MEDIA_PUBLISH_BACKOFF_BASE_MS);
  });

  it('doubles with every further attempt', () => {
    expect(computeBackoffMs(2)).toBe(MEDIA_PUBLISH_BACKOFF_BASE_MS * 2);
    expect(computeBackoffMs(3)).toBe(MEDIA_PUBLISH_BACKOFF_BASE_MS * 4);
    expect(computeBackoffMs(4)).toBe(MEDIA_PUBLISH_BACKOFF_BASE_MS * 8);
  });

  it('is monotonically non-decreasing and clamped to the maximum', () => {
    let previous = 0;
    for (let attempts = 1; attempts <= 40; attempts++) {
      const delay = computeBackoffMs(attempts);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(MEDIA_PUBLISH_BACKOFF_MAX_MS);
      previous = delay;
    }
    expect(computeBackoffMs(40)).toBe(MEDIA_PUBLISH_BACKOFF_MAX_MS);
  });
});
