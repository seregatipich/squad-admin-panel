import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { redactSecrets } from '../redact.js';
import type { MediaPublisher, PublishOutcome } from '../tick.js';

/**
 * YouTube Data API quota is a *daily* allowance that resets at midnight
 * Pacific, not on a rolling window — so a `quotaExceeded` job is scheduled for
 * the next reset rather than a blind backoff.
 */
export const YOUTUBE_QUOTA_RESET_TIMEZONE = 'America/Los_Angeles';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const RESUMABLE_ENDPOINT =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus';

/**
 * Hard timeouts for every Google fetch. Without one, a hung TCP connection
 * blocks a claimed job — and the whole sequential tick, since nothing else
 * bounds concurrency (#63 finding 957) — indefinitely. The token and
 * resumable-session calls are small metadata requests; the PUT upload can
 * carry up to 2GiB (`readMedia`'s own cap), so it gets a much longer budget.
 */
export const YOUTUBE_METADATA_TIMEOUT_MS = Number(
  process.env.YOUTUBE_METADATA_TIMEOUT_MS ?? 30_000,
);
export const YOUTUBE_UPLOAD_TIMEOUT_MS = Number(
  process.env.YOUTUBE_UPLOAD_TIMEOUT_MS ?? 30 * 60 * 1000,
);

/** Reasons Google returns when the daily allowance (or its per-second burst) is spent. */
const QUOTA_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']);

export interface YouTubePublisherConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  mediaBaseDir: string;
  fetch?: typeof fetch;
  /**
   * Reads the file to upload, from byte `opts.start` when resuming. Returns
   * anything `fetch` accepts as a body: production streams the file, so a
   * multi-GiB video never sits in memory and Node's `fs.readFile` ceiling at
   * 2^31 bytes never applies; tests pass a plain `Uint8Array`.
   */
  readMedia?: (absolutePath: string, opts?: { start?: number }) => Promise<UploadBody>;
  now?: () => Date;
}

/** Whatever `readMedia` can hand to `fetch`: a buffer in tests, a stream in production. */
export type UploadBody = Uint8Array | ReadableStream<Uint8Array>;

/** Milliseconds from `now` until the next quota reset (local midnight in the quota timezone). */
export function msUntilQuotaReset(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: YOUTUBE_QUOTA_RESET_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = get('hour') % 24;
  const elapsedMs = ((hour * 60 + get('minute')) * 60 + get('second')) * 1000;
  const dayMs = 24 * 3_600_000;
  // Always strictly positive: exactly at midnight the next reset is a full day out.
  return dayMs - elapsedMs;
}

interface GoogleErrorBody {
  error?: {
    message?: string;
    errors?: { reason?: string }[];
  };
}

/** True when a Google error body names a quota/rate-limit reason. */
export function isQuotaError(body: unknown): boolean {
  const errors = (body as GoogleErrorBody | undefined)?.error?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((entry) => entry?.reason && QUOTA_REASONS.has(entry.reason));
}

/**
 * Creates a YouTube publisher, or `null` unless the whole OAuth triple is
 * present. A partially configured app is treated as unconfigured — attempting
 * a refresh with two of three values only produces a confusing auth failure.
 *
 * Talks to the Data API over raw `fetch` (OAuth refresh → resumable session →
 * byte upload) rather than pulling in `googleapis`, matching how this repo
 * already talks to Discord and Steam.
 */
export function createYouTubePublisher(config: YouTubePublisherConfig): MediaPublisher | null {
  const { clientId, clientSecret, refreshToken } = config;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const doFetch = config.fetch ?? fetch;
  const readMedia =
    config.readMedia ??
    ((absolutePath: string, opts?: { start?: number }) =>
      Promise.resolve(
        Readable.toWeb(
          createReadStream(absolutePath, opts?.start ? { start: opts.start } : undefined),
        ) as unknown as ReadableStream<Uint8Array>,
      ));
  const clock = config.now ?? (() => new Date());

  return async (job): Promise<PublishOutcome> => {
    if (!job.storagePath) return { ok: false, retryable: false, error: 'no_local_file' };
    if (!job.mimeType.startsWith('video/')) {
      return { ok: false, retryable: false, error: 'youtube_unsupported_kind' };
    }

    // Every secret that could surface in an error message, scrubbed in one place.
    // `accessToken` joins the list as soon as the refresh returns it.
    const secrets: (string | undefined)[] = [clientId, clientSecret, refreshToken];
    const scrub = (message: string): string => redactSecrets(message, secrets);
    // The session URL rides on every retryable outcome once a session is open,
    // so even a quota wall hit mid-upload keeps the progress instead of
    // re-uploading the whole file (or duplicating the video) next attempt.
    const quotaOutcome = (uploadSessionUrl?: string | null): FailureOutcome => ({
      ok: false,
      retryable: true,
      quota: true,
      error: 'quota_exceeded',
      retryAfterMs: msUntilQuotaReset(clock()),
      ...(uploadSessionUrl !== undefined ? { uploadSessionUrl } : {}),
    });

    // --- 1. Refresh token -> access token -------------------------------
    let accessToken: string;
    try {
      const tokenRes = await doFetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(YOUTUBE_METADATA_TIMEOUT_MS),
      });
      if (tokenRes.status >= 500) {
        return {
          ok: false,
          retryable: true,
          error: `youtube_token_server_error_${tokenRes.status}`,
        };
      }
      if (!tokenRes.ok) {
        return { ok: false, retryable: false, error: 'youtube_auth_failed' };
      }
      const tokenBody = (await tokenRes.json()) as { access_token?: string };
      if (!tokenBody.access_token) {
        return { ok: false, retryable: false, error: 'youtube_auth_failed' };
      }
      accessToken = tokenBody.access_token;
      secrets.push(accessToken);
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: scrub(`youtube_transport_error: ${(err as Error).message}`),
      };
    }

    // --- 2. Resume a persisted session, or open a new one ----------------
    // A persisted session means an earlier attempt already opened one and may
    // have sent some or all of the bytes (with the response lost). Asking
    // Google for its status first is what stops a retry from publishing a
    // duplicate video or re-sending bytes Google already holds.
    let uploadUrl = '';
    let resumeFromByte = 0;
    if (job.uploadSessionUrl) {
      uploadUrl = job.uploadSessionUrl;
      try {
        const statusRes = await doFetch(uploadUrl, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-range': `bytes */${job.sizeBytes}`,
            'content-length': '0',
          },
          signal: AbortSignal.timeout(YOUTUBE_METADATA_TIMEOUT_MS),
        });

        if (statusRes.status === 404 || statusRes.status === 410) {
          uploadUrl = '';
        } else if (statusRes.status === 308) {
          const range = statusRes.headers.get('range');
          const uploadedEnd = range ? Number(range.split('-')[1]) : Number.NaN;
          resumeFromByte = Number.isFinite(uploadedEnd) ? uploadedEnd + 1 : 0;
        } else if (statusRes.ok) {
          const uploaded = (await statusRes.json()) as { id?: string };
          if (uploaded.id) {
            return {
              ok: true,
              externalId: uploaded.id,
              externalUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
            };
          }
          uploadUrl = '';
        } else {
          const failure = await classifyFailure(
            statusRes,
            () => quotaOutcome(job.uploadSessionUrl),
            scrub,
            'youtube_session_status',
          );
          return (
            failure ?? {
              ok: false,
              retryable: true,
              error: `youtube_session_status_${statusRes.status}`,
              uploadSessionUrl: job.uploadSessionUrl,
            }
          );
        }
      } catch (err) {
        return {
          ok: false,
          retryable: true,
          error: scrub(`youtube_transport_error: ${(err as Error).message}`),
          uploadSessionUrl: job.uploadSessionUrl,
        };
      }
    }

    if (!uploadUrl) {
      try {
        const initiateRes = await doFetch(RESUMABLE_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            'x-upload-content-length': String(job.sizeBytes),
            'x-upload-content-type': job.mimeType,
          },
          body: JSON.stringify({
            snippet: {
              title: (job.title ?? job.originalFilename).slice(0, 100),
              description: job.description ?? '',
            },
            // Unlisted, not public: this is moderation evidence fanned out to a
            // community channel, and the panel must not silently make every clip
            // searchable on the open web.
            status: { privacyStatus: 'unlisted' },
          }),
          signal: AbortSignal.timeout(YOUTUBE_METADATA_TIMEOUT_MS),
        });
        const failure = await classifyFailure(
          initiateRes,
          () => quotaOutcome(),
          scrub,
          'youtube_initiate',
        );
        if (failure) return failure;

        const location = initiateRes.headers.get('location');
        if (!location) {
          return { ok: false, retryable: true, error: 'youtube_no_upload_session' };
        }
        uploadUrl = location;
        resumeFromByte = 0;
      } catch (err) {
        return {
          ok: false,
          retryable: true,
          error: scrub(`youtube_transport_error: ${(err as Error).message}`),
        };
      }
    }

    // --- 3. Upload the bytes (or the remainder, when resuming) -----------
    try {
      const body = await readMedia(path.join(config.mediaBaseDir, job.storagePath), {
        start: resumeFromByte,
      });
      const uploadRes = await doFetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': job.mimeType,
          'content-length': String(job.sizeBytes - resumeFromByte),
          'content-range': `bytes ${resumeFromByte}-${job.sizeBytes - 1}/${job.sizeBytes}`,
        },
        body,
        // undici requires `duplex: 'half'` whenever the body is a stream.
        duplex: 'half',
        signal: AbortSignal.timeout(YOUTUBE_UPLOAD_TIMEOUT_MS),
      } as RequestInit & { duplex: 'half' });
      const failure = await classifyFailure(
        uploadRes,
        () => quotaOutcome(uploadUrl),
        scrub,
        'youtube_upload',
      );
      if (failure) return failure.retryable ? { ...failure, uploadSessionUrl: uploadUrl } : failure;

      const uploaded = (await uploadRes.json()) as { id?: string };
      if (!uploaded.id) {
        return {
          ok: false,
          retryable: true,
          error: 'youtube_missing_video_id',
          uploadSessionUrl: uploadUrl,
        };
      }
      return {
        ok: true,
        externalId: uploaded.id,
        externalUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
      };
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: scrub(`youtube_transport_error: ${(err as Error).message}`),
        uploadSessionUrl: uploadUrl,
      };
    }
  };
}

/** The failure branch of `PublishOutcome` — `classifyFailure` never reports success. */
type FailureOutcome = Extract<PublishOutcome, { ok: false }>;

/**
 * Maps a non-OK Google response to an outcome, or `null` when it succeeded.
 * Quota is checked before the generic 4xx branch, because it arrives as a 403
 * and would otherwise be misfiled as a permanent rejection.
 */
async function classifyFailure(
  response: Response,
  quotaOutcome: () => FailureOutcome,
  scrub: (message: string) => string,
  prefix: string,
): Promise<FailureOutcome | null> {
  if (response.ok) return null;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }

  if (isQuotaError(body)) return quotaOutcome();
  if (response.status >= 500) {
    return { ok: false, retryable: true, error: `${prefix}_server_error_${response.status}` };
  }
  const message = (body as GoogleErrorBody | undefined)?.error?.message;
  return {
    ok: false,
    retryable: false,
    error: scrub(`${prefix}_rejected_${response.status}: ${message ?? ''}`.trim()),
  };
}
