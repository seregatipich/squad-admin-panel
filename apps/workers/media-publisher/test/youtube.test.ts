import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createYouTubePublisher,
  msUntilQuotaReset,
  YOUTUBE_QUOTA_RESET_TIMEZONE,
} from '../src/publishers/youtube.js';
import type { MediaPublicationJob } from '../src/tick.js';

const CLIENT_ID = '1234-fake.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-fake-client-secret';
const REFRESH_TOKEN = '1//0f-fake-refresh-token';
const ACCESS_TOKEN = 'ya29.fake-access-token';
const RESUMABLE_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fake-session';

function makeJob(overrides: Partial<MediaPublicationJob> = {}): MediaPublicationJob {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    mediaId: '018f0000-0000-7000-8000-0000000000aa',
    destination: 'youtube',
    attempts: 0,
    storagePath: '2026/07/clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 4,
    title: 'Нарушение на Yehorivka',
    description: 'Доказательство бана',
    originalFilename: 'clip.mp4',
    interrupted: false,
    uploadSessionUrl: null,
    ...overrides,
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Fetch double driving the three-leg OAuth + resumable-upload conversation. */
function scriptedFetch(
  overrides: { token?: () => Response; initiate?: () => Response; upload?: () => Response } = {},
): {
  fetch: typeof fetch;
  requests: { url: string; method: string; hasSignal: boolean }[];
} {
  const requests: { url: string; method: string; hasSignal: boolean }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', hasSignal: init?.signal != null });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return overrides.token?.() ?? jsonResponse(200, { access_token: ACCESS_TOKEN });
    }
    if (url === RESUMABLE_URL) {
      return overrides.upload?.() ?? jsonResponse(200, { id: 'yt-video-1' });
    }
    return (
      overrides.initiate?.() ??
      new Response(null, { status: 200, headers: { location: RESUMABLE_URL } })
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function makePublisher(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createYouTubePublisher>[0]> = {},
) {
  const publisher = createYouTubePublisher({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN,
    mediaBaseDir: '/srv/media',
    fetch: fetchImpl,
    readMedia: async () => new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  });
  if (!publisher) throw new Error('expected a configured youtube publisher');
  return publisher;
}

describe('createYouTubePublisher — configuration gate', () => {
  it.each([
    ['client id', { clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN }],
    ['client secret', { clientId: CLIENT_ID, refreshToken: REFRESH_TOKEN }],
    ['refresh token', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }],
  ])('returns null when the %s is absent', (_label, partial) => {
    expect(createYouTubePublisher({ ...partial, mediaBaseDir: '/srv/media' })).toBeNull();
  });

  it('returns a publisher when the full OAuth triple is present', () => {
    expect(
      createYouTubePublisher({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        mediaBaseDir: '/srv/media',
      }),
    ).toBeTypeOf('function');
  });
});

describe('msUntilQuotaReset', () => {
  it('resolves the reset to the configured quota timezone', () => {
    expect(YOUTUBE_QUOTA_RESET_TIMEZONE).toBe('America/Los_Angeles');
  });

  it('is always strictly positive and at most 24 hours ahead', () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(Date.UTC(2026, 6, 27, hour, 30, 0));
      const ms = msUntilQuotaReset(now);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(24 * 3_600_000);
    }
  });

  it('lands exactly on local midnight in the quota timezone', () => {
    const now = new Date(Date.UTC(2026, 6, 27, 12, 0, 0));
    const reset = new Date(now.getTime() + msUntilQuotaReset(now));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: YOUTUBE_QUOTA_RESET_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(reset);
    expect(parts).toBe('00:00');
  });
});

describe('createYouTubePublisher — publishing', () => {
  it('exchanges the refresh token, initiates a resumable upload and returns the watch url', async () => {
    const { fetch: fetchImpl, requests } = scriptedFetch();
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toEqual({
      ok: true,
      externalId: 'yt-video-1',
      externalUrl: 'https://www.youtube.com/watch?v=yt-video-1',
    });
    expect(requests.map((r) => r.method)).toEqual(['POST', 'POST', 'PUT']);
    expect(requests[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(requests[1]?.url).toContain('uploadType=resumable');
    expect(requests[2]?.url).toBe(RESUMABLE_URL);
  });

  it('rejects a non-video media kind without contacting the API', async () => {
    const { fetch: fetchImpl, requests } = scriptedFetch();
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob({ mimeType: 'image/png' }));

    expect(outcome).toEqual({ ok: false, retryable: false, error: 'youtube_unsupported_kind' });
    expect(requests).toHaveLength(0);
  });

  it('rejects a media row that has no local file to upload', async () => {
    const { fetch: fetchImpl, requests } = scriptedFetch();
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob({ storagePath: null }));

    expect(outcome).toEqual({ ok: false, retryable: false, error: 'no_local_file' });
    expect(requests).toHaveLength(0);
  });

  it('fails permanently when the resumable session has no location header', async () => {
    const { fetch: fetchImpl } = scriptedFetch({
      initiate: () => new Response(null, { status: 200 }),
    });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({
      ok: false,
      retryable: true,
      error: 'youtube_no_upload_session',
    });
  });
});

describe('createYouTubePublisher — quota handling', () => {
  const quotaBody = {
    error: {
      code: 403,
      message: 'The request cannot be completed because you have exceeded your quota.',
      errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }],
    },
  };

  it('classifies a quotaExceeded error on session initiation as a quota deferral, not a failure', async () => {
    const now = new Date(Date.UTC(2026, 6, 27, 12, 0, 0));
    const { fetch: fetchImpl } = scriptedFetch({
      initiate: () => jsonResponse(403, quotaBody),
    });
    const publisher = makePublisher(fetchImpl, { now: () => now });

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({
      ok: false,
      retryable: true,
      quota: true,
      error: 'quota_exceeded',
    });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.retryAfterMs).toBe(msUntilQuotaReset(now));
  });

  it('classifies a quotaExceeded error during the byte upload as a quota deferral', async () => {
    const { fetch: fetchImpl } = scriptedFetch({ upload: () => jsonResponse(403, quotaBody) });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ quota: true, retryable: true, error: 'quota_exceeded' });
  });

  it('classifies rateLimitExceeded as a quota deferral too', async () => {
    const { fetch: fetchImpl } = scriptedFetch({
      initiate: () => jsonResponse(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
    });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ quota: true, retryable: true });
  });

  it('does not treat an unrelated 403 as a quota deferral', async () => {
    const { fetch: fetchImpl } = scriptedFetch({
      initiate: () => jsonResponse(403, { error: { errors: [{ reason: 'forbidden' }] } }),
    });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(outcome).not.toHaveProperty('quota', true);
  });
});

describe('createYouTubePublisher — auth and transport failures', () => {
  it('fails permanently when the refresh token is rejected', async () => {
    const { fetch: fetchImpl } = scriptedFetch({
      token: () => jsonResponse(400, { error: 'invalid_grant' }),
    });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: false, error: 'youtube_auth_failed' });
  });

  it('retries when the token endpoint is temporarily unavailable', async () => {
    const { fetch: fetchImpl } = scriptedFetch({ token: () => jsonResponse(503, {}) });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });

  it('retries on a transport failure', async () => {
    const publisher = makePublisher((async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof fetch);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });
});

describe('createYouTubePublisher — secret hygiene', () => {
  it('never leaks OAuth credentials in an error outcome', async () => {
    const publisher = makePublisher((async () => {
      throw new Error(
        `refresh failed for client ${CLIENT_ID} secret ${CLIENT_SECRET} token ${REFRESH_TOKEN}`,
      );
    }) as unknown as typeof fetch);

    const outcome = await publisher(makeJob());

    const serialized = JSON.stringify(outcome);
    for (const secret of [CLIENT_SECRET, REFRESH_TOKEN]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[redacted]');
  });

  it('never leaks the access token obtained from the refresh exchange', async () => {
    const { fetch: fetchImpl } = scriptedFetch({
      initiate: () => jsonResponse(500, { error: { message: `bad token ${ACCESS_TOKEN}` } }),
    });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(JSON.stringify(outcome)).not.toContain(ACCESS_TOKEN);
  });
});

describe('youtube publisher — request shape', () => {
  it('sends the media title and description as the video snippet', async () => {
    let initiateBody: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: ACCESS_TOKEN });
      }
      if (url === RESUMABLE_URL) return jsonResponse(200, { id: 'yt-video-1' });
      initiateBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 200, headers: { location: RESUMABLE_URL } });
    }) as unknown as typeof fetch;
    const publisher = makePublisher(fetchImpl);

    await publisher(makeJob());

    expect(initiateBody).toMatchObject({
      snippet: { title: 'Нарушение на Yehorivka', description: 'Доказательство бана' },
      status: { privacyStatus: 'unlisted' },
    });
  });

  it('falls back to the original filename when the media has no title', async () => {
    let initiateBody: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: ACCESS_TOKEN });
      }
      if (url === RESUMABLE_URL) return jsonResponse(200, { id: 'yt-video-1' });
      initiateBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 200, headers: { location: RESUMABLE_URL } });
    }) as unknown as typeof fetch;
    const publisher = makePublisher(fetchImpl);

    await publisher(makeJob({ title: null, description: null }));

    expect(initiateBody).toMatchObject({ snippet: { title: 'clip.mp4', description: '' } });
  });
});

// Regression for #63 finding 957: none of the token/initiate/upload fetch
// calls carried a signal, so a hung TCP connection to Google could block a
// claimed job (and the whole sequential tick) indefinitely.
describe('youtube publisher — request timeouts', () => {
  it('attaches an abort signal to every Google fetch call', async () => {
    const { fetch: fetchImpl, requests } = scriptedFetch();
    const publisher = makePublisher(fetchImpl);

    await publisher(makeJob());

    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.hasSignal)).toBe(true);
  });
});

describe('createYouTubePublisher — default readMedia streams instead of buffering', () => {
  it('uploads the file as a stream with the byte-length content-length and duplex: half', async () => {
    const mediaDir = mkdtempSync(path.join(tmpdir(), 'youtube-publisher-test-'));
    try {
      const contents = Buffer.from('fake-video-bytes-for-streaming-test');
      writeFileSync(path.join(mediaDir, 'clip.mp4'), contents);

      let uploadInit: RequestInit | undefined;
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://oauth2.googleapis.com/token')) {
          return jsonResponse(200, { access_token: ACCESS_TOKEN });
        }
        if (url === RESUMABLE_URL) {
          uploadInit = init;
          // Drain the body the way undici would, to prove it is readable at all.
          const body = init?.body;
          if (body instanceof ReadableStream) {
            const reader = body.getReader();
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
              /* draining only */
            }
          }
          return jsonResponse(200, { id: 'yt-video-1' });
        }
        return new Response(null, { status: 200, headers: { location: RESUMABLE_URL } });
      }) as unknown as typeof fetch;

      const publisher = createYouTubePublisher({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        mediaBaseDir: mediaDir,
        fetch: fetchImpl,
        // No `readMedia` override: exercises the production default.
      });
      if (!publisher) throw new Error('expected a configured youtube publisher');

      const outcome = await publisher(
        makeJob({ storagePath: 'clip.mp4', sizeBytes: contents.byteLength }),
      );

      expect(outcome).toEqual({
        ok: true,
        externalId: 'yt-video-1',
        externalUrl: 'https://www.youtube.com/watch?v=yt-video-1',
      });
      expect(uploadInit?.body).toBeInstanceOf(ReadableStream);
      expect((uploadInit?.headers as Record<string, string>)?.['content-length']).toBe(
        String(contents.byteLength),
      );
      expect((uploadInit as RequestInit & { duplex?: string })?.duplex).toBe('half');
    } finally {
      rmSync(mediaDir, { recursive: true, force: true });
    }
  });
});

describe('createYouTubePublisher — resumable session recovery (#956)', () => {
  it('persists the upload session url when the byte upload fails, instead of losing it', async () => {
    const { fetch: fetchImpl } = scriptedFetch({
      upload: () => new Response(null, { status: 503 }),
    });
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({
      ok: false,
      retryable: true,
      error: 'youtube_upload_server_error_503',
      uploadSessionUrl: RESUMABLE_URL,
    });
  });

  it('checks the session status instead of re-uploading, and reports the video as already-published when Google already finalized it', async () => {
    const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: ACCESS_TOKEN });
      }
      // The persisted session url: a status check (Content-Range: bytes */N)
      // reports the upload as already finalized.
      return jsonResponse(200, { id: 'yt-video-already-uploaded' });
    }) as unknown as typeof fetch;
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(makeJob({ uploadSessionUrl: RESUMABLE_URL }));

    expect(outcome).toEqual({
      ok: true,
      externalId: 'yt-video-already-uploaded',
      externalUrl: 'https://www.youtube.com/watch?v=yt-video-already-uploaded',
    });
    // Never a fresh POST to open a new session, and never a byte upload —
    // only the token refresh and the one status-check PUT.
    expect(requests.map((r) => r.method)).toEqual(['POST', 'PUT']);
    expect(requests[1]?.url).toBe(RESUMABLE_URL);
    expect(requests[1]?.headers['content-range']).toBe(`bytes */${makeJob().sizeBytes}`);
  });

  it('resumes from the byte offset Google reports (308 + Range) instead of re-uploading from zero', async () => {
    const already = 2;
    let uploadedBody: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: ACCESS_TOKEN });
      }
      if (init?.headers && (init.headers as Record<string, string>)['content-length'] === '0') {
        // The status check.
        return new Response(null, { status: 308, headers: { range: `bytes=0-${already - 1}` } });
      }
      uploadedBody = init?.body;
      return jsonResponse(200, { id: 'yt-video-resumed' });
    }) as unknown as typeof fetch;

    const readCalls: { path: string; opts?: { start?: number } }[] = [];
    const publisher = createYouTubePublisher({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
      mediaBaseDir: '/srv/media',
      fetch: fetchImpl,
      readMedia: async (absolutePath, opts) => {
        readCalls.push({ path: absolutePath, opts });
        return new Uint8Array([3, 4]);
      },
    });
    if (!publisher) throw new Error('expected a configured youtube publisher');

    const outcome = await publisher(makeJob({ uploadSessionUrl: RESUMABLE_URL, sizeBytes: 4 }));

    expect(outcome).toEqual({
      ok: true,
      externalId: 'yt-video-resumed',
      externalUrl: 'https://www.youtube.com/watch?v=yt-video-resumed',
    });
    expect(readCalls).toEqual([{ path: '/srv/media/2026/07/clip.mp4', opts: { start: 2 } }]);
    expect(uploadedBody).toEqual(new Uint8Array([3, 4]));
  });

  it('opens a brand new session when the persisted one has expired (404/410)', async () => {
    const requests: { url: string; method: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: ACCESS_TOKEN });
      }
      if (url === 'https://old-session.example/upload') {
        return new Response(null, { status: 404 });
      }
      if (url === RESUMABLE_URL) return jsonResponse(200, { id: 'yt-video-fresh' });
      return new Response(null, { status: 200, headers: { location: RESUMABLE_URL } });
    }) as unknown as typeof fetch;
    const publisher = makePublisher(fetchImpl);

    const outcome = await publisher(
      makeJob({ uploadSessionUrl: 'https://old-session.example/upload' }),
    );

    expect(outcome).toEqual({
      ok: true,
      externalId: 'yt-video-fresh',
      externalUrl: 'https://www.youtube.com/watch?v=yt-video-fresh',
    });
    // Status check on the dead session, then a fresh initiate, then the upload.
    expect(requests.map((r) => r.method)).toEqual(['POST', 'PUT', 'POST', 'PUT']);
    expect(requests[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(requests[1]?.url).toBe('https://old-session.example/upload');
  });
});
