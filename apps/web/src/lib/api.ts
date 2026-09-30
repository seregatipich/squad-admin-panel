const API_URL = process.env.API_URL ?? 'http://api:3000';

/**
 * Default upper bound for one API request, in milliseconds. Every panel
 * request is a short read; a hung API must fail the render quickly instead of
 * holding it (and its socket) until undici's default ~300 s timeout.
 */
export const API_TIMEOUT_MS = 10_000;

export interface RequestOptions<T = unknown> extends RequestInit {
  cookie?: string;
  /**
   * Checks the decoded response body and returns it typed; it must throw on a
   * malformed body. Without it the body is only asserted to be `T`.
   */
  parse?: (body: unknown) => T;
}

/** A 2xx response whose body is not JSON, or does not match the caller's `parse` check. */
export class ApiResponseError extends Error {
  /**
   * @param path Requested API path, e.g. `/api/v1/me`.
   * @param reason Why the body was rejected.
   */
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`API ${path} returned an unexpected body: ${reason}`);
    this.name = 'ApiResponseError';
  }
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
 *
 * `T` is the caller's assertion about the response body. It is validated at
 * runtime only when `opts.parse` is given (the session and setup-status reads
 * whose fields the layout dereferences at once); without it the body is cast.
 * A `204 No Content` answer has no body: `parse` receives `undefined` and
 * without `parse` the result is `undefined`.
 *
 * @throws {ApiResponseError} The body is not JSON or `opts.parse` rejected it.
 */
export async function apiFetch<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('accept', 'application/json');
  if (opts.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const url = typeof window === 'undefined' ? `${API_URL}${path}` : path;
  const { parse, ...init } = opts;
  const res = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: opts.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new ApiError(path, res.status, await res.text());
  let body: unknown;
  if (res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      throw new ApiResponseError(path, 'body is not valid JSON');
    }
  }
  if (!parse) return body as T;
  try {
    return parse(body);
  } catch (error) {
    throw new ApiResponseError(path, error instanceof Error ? error.message : String(error));
  }
}
