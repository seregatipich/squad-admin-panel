const API_URL = process.env.API_URL ?? 'http://api:3000';

/**
 * Default upper bound for one API request, in milliseconds. Every panel
 * request is a short read; a hung API must fail the render quickly instead of
 * holding it (and its socket) until undici's default ~300 s timeout.
 */
export const API_TIMEOUT_MS = 10_000;

export interface RequestOptions<T = unknown> extends Omit<RequestInit, 'body'> {
  cookie?: string;
  /** Raw request body; `json` is the usual choice. */
  body?: BodyInit | null;
  /**
   * JSON request body. It is serialised with `JSON.stringify` and implies
   * `content-type: application/json`; pass either `json` or `body`, not both.
   */
  json?: unknown;
  /**
   * Abort the request after this many milliseconds, in addition to the
   * caller's `signal` when there is one. Without it a read (GET/HEAD) is
   * bounded by {@link API_TIMEOUT_MS} unless the caller passes its own
   * `signal`, and any other method is not bounded at all; `null` removes the
   * bound from a read too.
   */
  timeoutMs?: number | null;
  /**
   * Checks the decoded response body and returns it typed; it must throw on a
   * malformed body. Without it the body is only asserted to be `T`.
   */
  parse?: (body: unknown) => T;
  /**
   * Do not read the response body: a 2xx answer resolves to `undefined` even
   * when the body is empty or not JSON. For a mutation (through
   * {@link apiResult}) whose answer the caller only checks for success.
   */
  discardBody?: boolean;
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
   * @param responseText Full response body, kept for callers that show it; the
   *   message carries only its first 200 characters.
   */
  constructor(
    readonly path: string,
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`API ${path} ${status}: ${responseText.slice(0, 200)}`);
    this.name = 'ApiError';
  }

  /**
   * The response body decoded as JSON, for pages that show the API's own
   * `message`/`error` field. `null` when the body is empty or not JSON.
   *
   * @typeParam T Shape the caller expects; it is asserted, not validated.
   */
  jsonBody<T = unknown>(): T | null {
    try {
      return JSON.parse(this.responseText) as T;
    } catch {
      return null;
    }
  }

  /**
   * What a page appends to its own failure caption: the API's `error` code
   * from a JSON body, else the HTTP status.
   */
  codeOrStatus(): string | number {
    const body = this.jsonBody<{ error?: unknown } | null>();
    const code = body?.error;
    return typeof code === 'string' ? code : this.status;
  }
}

/**
 * Text for a panel error strip. An API answer reads `HTTP 500` (with the
 * response body appended after a colon when `withBody` is set); anything else
 * (network failure, malformed body) shows the thrown error's own message.
 */
export function describeHttpError(error: unknown, withBody = false): string {
  if (error instanceof ApiError) {
    return withBody ? `HTTP ${error.status}: ${error.responseText}` : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * `.catch` handler for a read where an error status simply means "nothing to
 * show" (a missing permission, an optional resource): an {@link ApiError}
 * becomes `null`, while anything else (a network failure, a malformed body)
 * is rethrown so the caller's own error path still sees it.
 */
export function nullOnHttpError(error: unknown): null {
  if (error instanceof ApiError) return null;
  throw error;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function isRead(method: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  return verb === 'GET' || verb === 'HEAD';
}

function requestSignal(opts: RequestOptions<unknown>): AbortSignal | undefined {
  if (opts.timeoutMs === undefined) {
    // Only a read is short by contract; a mutation may run a bridge operation
    // that legitimately outlasts it, and failing the page while the API keeps
    // working would be worse than waiting.
    if (opts.signal) return opts.signal;
    return isRead(opts.method) ? AbortSignal.timeout(API_TIMEOUT_MS) : undefined;
  }
  if (opts.timeoutMs === null) return opts.signal ?? undefined;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/**
 * Issues the request and throws {@link ApiError} for a non-2xx answer. The
 * credentials default (`include`) matches what every panel call has always
 * sent; it is a no-op for the server-side fetch.
 */
async function request(path: string, opts: RequestOptions<unknown>): Promise<Response> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('accept', 'application/json');
  const body = opts.json === undefined ? opts.body : JSON.stringify(opts.json);
  if (body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const url = typeof window === 'undefined' ? `${API_URL}${path}` : path;
  const {
    parse: _parse,
    json: _json,
    timeoutMs: _timeoutMs,
    cookie: _cookie,
    discardBody: _discardBody,
    ...init
  } = opts;
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    body,
    headers,
    cache: 'no-store',
    signal: requestSignal(opts),
  });
  if (!res.ok) throw new ApiError(path, res.status, await readErrorBody(res));
  return res;
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
 * A read is aborted after {@link API_TIMEOUT_MS} unless the caller passes its
 * own `signal` or `timeoutMs`; a mutation is not time-bounded by default.
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
  const res = await request(path, opts);
  if (opts.discardBody) return undefined as T;
  let body: unknown;
  if (res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      throw new ApiResponseError(path, 'body is not valid JSON');
    }
  }
  if (!opts.parse) return body as T;
  try {
    return opts.parse(body);
  } catch (error) {
    throw new ApiResponseError(path, error instanceof Error ? error.message : String(error));
  }
}

/** Outcome of {@link apiResult}: the decoded body, or the API's error answer. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/**
 * {@link apiFetch} for a caller that branches on the answer instead of
 * catching: an error status comes back as `{ ok: false, error }` (the status
 * is `error.status`, the body `error.jsonBody()`), so a page that shows a
 * caption per status reads like the `if (res.ok)` code it replaces. Only a
 * transport failure, an abort or a malformed 2xx body still throws.
 */
export async function apiResult<T>(
  path: string,
  opts: RequestOptions<T> = {},
): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await apiFetch<T>(path, opts) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error };
    throw error;
  }
}

/**
 * Sends a request whose response body the caller does not use (a mutation
 * that only needs to know it succeeded). The body is never read, so an empty
 * or non-JSON 2xx answer is fine.
 *
 * @throws {ApiError} The API answered with a non-2xx status.
 * @throws {DOMException} `TimeoutError`/`AbortError` when the request was aborted.
 */
export async function apiSend(path: string, opts: RequestOptions<never> = {}): Promise<void> {
  await apiFetch<void>(path, { ...opts, discardBody: true });
}
