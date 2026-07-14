export const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.BAN_SYNC_FETCH_TIMEOUT_MS ?? 30_000);
export const DEFAULT_MAX_BYTES = Number(process.env.BAN_SYNC_MAX_BYTES ?? 20 * 1024 * 1024);

export type FetchSourceErrorReason = 'timeout' | 'http_status' | 'size_limit_exceeded' | 'network';

export class FetchSourceError extends Error {
  readonly reason: FetchSourceErrorReason;

  constructor(reason: FetchSourceErrorReason, message: string) {
    super(message);
    this.name = 'FetchSourceError';
    this.reason = reason;
  }
}

export interface FetchBanListResult {
  text: string;
  bytes: number;
  durationMs: number;
}

export interface FetchBanListOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Downloads a ban-list source with a hard timeout and a hard byte cap.
 *
 * The cap is enforced twice: eagerly against a `content-length` response
 * header (fails fast without reading the body), and defensively while
 * streaming the body (a server that lies about `content-length`, or omits
 * it, is still cut off mid-stream once the cap is crossed).
 */
export async function fetchBanList(
  url: string,
  authHeader: string | null,
  opts: FetchBanListOptions = {},
): Promise<FetchBanListResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: authHeader ? { Authorization: authHeader } : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw new FetchSourceError('timeout', `fetch timed out after ${timeoutMs}ms`);
    }
    throw new FetchSourceError('network', (err as Error).message);
  }

  try {
    if (!response.ok) {
      throw new FetchSourceError('http_status', `unexpected HTTP status ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new FetchSourceError(
        'size_limit_exceeded',
        `content-length ${contentLength} exceeds ${maxBytes} byte cap`,
      );
    }

    if (!response.body) {
      const text = await response.text();
      const bytes = Buffer.byteLength(text, 'utf-8');
      if (bytes > maxBytes) {
        throw new FetchSourceError(
          'size_limit_exceeded',
          `body of ${bytes} bytes exceeds ${maxBytes} byte cap`,
        );
      }
      return { text, bytes, durationMs: Date.now() - started };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new FetchSourceError(
              'size_limit_exceeded',
              `body exceeded ${maxBytes} byte cap mid-stream`,
            );
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      if (err instanceof FetchSourceError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new FetchSourceError('timeout', `fetch timed out after ${timeoutMs}ms`);
      }
      throw new FetchSourceError('network', (err as Error).message);
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
    return { text, bytes, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
