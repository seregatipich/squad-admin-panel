import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

/** Reasons Google returns when the daily allowance (or its per-second burst) is spent. */
const QUOTA_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']);

export interface YouTubePublisherConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  mediaBaseDir: string;
  fetch?: typeof fetch;
  readMedia?: (absolutePath: string) => Promise<Uint8Array>;
  now?: () => Date;
}

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
  const readMedia = config.readMedia ?? ((absolutePath: string) => readFile(absolutePath));
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
    const quotaOutcome = (): PublishOutcome => ({
      ok: false,
      retryable: true,
      quota: true,
      error: 'quota_exceeded',
      retryAfterMs: msUntilQuotaReset(clock()),
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

    // --- 2. Open a resumable upload session -----------------------------
    let uploadUrl: string;
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
      });
      const failure = await classifyFailure(initiateRes, quotaOutcome, scrub, 'youtube_initiate');
      if (failure) return failure;

      const location = initiateRes.headers.get('location');
      if (!location) {
        return { ok: false, retryable: true, error: 'youtube_no_upload_session' };
      }
      uploadUrl = location;
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: scrub(`youtube_transport_error: ${(err as Error).message}`),
      };
    }

    // --- 3. Upload the bytes --------------------------------------------
    try {
      const bytes = await readMedia(path.join(config.mediaBaseDir, job.storagePath));
      const uploadRes = await doFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': job.mimeType, 'content-length': String(bytes.byteLength) },
        body: bytes,
      });
      const failure = await classifyFailure(uploadRes, quotaOutcome, scrub, 'youtube_upload');
      if (failure) return failure;

      const uploaded = (await uploadRes.json()) as { id?: string };
      if (!uploaded.id) {
        return { ok: false, retryable: true, error: 'youtube_missing_video_id' };
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
      };
    }
  };
}

/**
 * Maps a non-OK Google response to an outcome, or `null` when it succeeded.
 * Quota is checked before the generic 4xx branch, because it arrives as a 403
 * and would otherwise be misfiled as a permanent rejection.
 */
async function classifyFailure(
  response: Response,
  quotaOutcome: () => PublishOutcome,
  scrub: (message: string) => string,
  prefix: string,
): Promise<PublishOutcome | null> {
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
