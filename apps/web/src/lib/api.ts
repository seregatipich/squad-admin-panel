const API_URL = process.env.API_URL ?? 'http://api:3000';

/**
 * Default upper bound for one API request, in milliseconds. Every panel
 * request is a short read; a hung API must fail the render quickly instead of
 * holding it (and its socket) until undici's default ~300 s timeout.
 */
export const API_TIMEOUT_MS = 10_000;

export interface RequestOptions extends RequestInit {
  cookie?: string;
}

/** Non-2xx API response. `status` lets callers tell "no session" from an outage. */
export class ApiError extends Error {
  /**
   * @param path Requested API path, e.g. `/api/v1/me`.
   * @param status HTTP status of the response.
   * @param body Start of the response body (first 200 characters).
   */
  constructor(
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`API ${path} ${status}: ${body.slice(0, 200)}`);
    this.name = 'ApiError';
  }
}

/**
 * Fetches a JSON API endpoint.
 *
 * Server-side (Server Components, route handlers) this targets `API_URL`
 * directly. Client-side (`'use client'` components running in the browser)
 * it issues a same-origin relative request instead: the browser cannot
 * resolve the internal `API_URL` host, but a relative path is forwarded to
 * the API by the Next.js rewrite in `next.config.mjs`.
 *
 * The request is aborted after {@link API_TIMEOUT_MS} unless the caller
 * passes its own `signal`.
 *
 * @throws {ApiError} The API answered with a non-2xx status.
 * @throws {DOMException} `TimeoutError`/`AbortError` when the request was aborted.
 */
export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('accept', 'application/json');
  if (opts.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const url = typeof window === 'undefined' ? `${API_URL}${path}` : path;
  const res = await fetch(url, {
    ...opts,
    headers,
    cache: 'no-store',
    signal: opts.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new ApiError(path, res.status, await res.text());
  return (await res.json()) as T;
}
