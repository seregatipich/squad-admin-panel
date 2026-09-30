import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { checkOutboundUrl, isPublicUnicastAddress } from '@squad/shared-config';
import { Agent, type Response, fetch as undiciFetch } from 'undici';
import { positiveIntEnv } from './env.js';

export const DEFAULT_FETCH_TIMEOUT_MS = positiveIntEnv('BAN_SYNC_FETCH_TIMEOUT_MS', 30_000);
export const DEFAULT_MAX_BYTES = positiveIntEnv('BAN_SYNC_MAX_BYTES', 20 * 1024 * 1024);
/** Redirect hops followed before a source is reported as failing. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export type FetchSourceErrorReason =
  | 'timeout'
  | 'http_status'
  | 'size_limit_exceeded'
  | 'network'
  | 'forbidden_destination';

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

/** Resolves a hostname to every address it maps to (defaults to `dns.lookup` with `all`). */
export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

export interface FetchBanListOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Whether the worker may connect to a resolved or literal address.
   * Defaults to {@link isPublicUnicastAddress}; tests opt loopback back in.
   */
  isAddressAllowed?: (address: string) => boolean;
  /** Injectable DNS resolution for tests; defaults to `dns.lookup(host, { all: true })`. */
  lookup?: ResolveHost;
}

const defaultResolveHost: ResolveHost = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Throws `forbidden_destination` unless `raw` passes the shared static
 * policy (`checkOutboundUrl`). An IP-literal host the shared policy refuses
 * is still accepted when `isAddressAllowed` admits it (tests only).
 */
function assertAllowedUrl(raw: string, isAddressAllowed: (address: string) => boolean): URL {
  const check = checkOutboundUrl(raw);
  if (check.ok) {
    const literal = check.url.hostname.replace(/^\[|\]$/g, '');
    if (/^[\d.]+$|:/.test(literal) && !isAddressAllowed(literal)) {
      throw new FetchSourceError('forbidden_destination', `destination ${literal} is not allowed`);
    }
    return check.url;
  }
  if (check.reason === 'forbidden_address') {
    const url = new URL(raw);
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isAddressAllowed(literal)) return url;
  }
  throw new FetchSourceError('forbidden_destination', `source URL refused: ${check.reason}`);
}

/** Marks a connection refused by the address policy inside the undici `lookup` hook. */
class ForbiddenAddressError extends Error {
  constructor(hostname: string, address: string) {
    super(`${hostname} resolves to ${address}, which is not allowed`);
    this.name = 'ForbiddenAddressError';
  }
}

/**
 * A `net.connect` `lookup` hook that resolves the host once and refuses the
 * connection when ANY resolved address is outside the policy. Checking at
 * connect time — not before `fetch` — leaves no window for DNS rebinding
 * between the check and the connection.
 */
function guardedLookup(
  resolveHost: ResolveHost,
  isAddressAllowed: (address: string) => boolean,
): LookupFunction {
  // On failure the address argument is ignored; `[]` only satisfies the type.
  return (hostname, options, callback) => {
    resolveHost(hostname).then(
      (entries) => {
        const first = entries[0];
        if (!first) {
          callback(
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }),
            [],
          );
          return;
        }
        const denied = entries.find((entry) => !isAddressAllowed(entry.address));
        if (denied) {
          callback(new ForbiddenAddressError(hostname, denied.address), []);
          return;
        }
        if (options?.all) callback(null, entries);
        else callback(null, first.address, first.family);
      },
      (err: Error) => callback(err, []),
    );
  };
}

function findForbiddenAddress(err: unknown): ForbiddenAddressError | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof ForbiddenAddressError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Downloads a ban-list source with a hard timeout, a hard byte cap and an
 * outbound address policy (audit #100).
 *
 * The URL, and every redirect target, must pass `checkOutboundUrl`; every
 * address a hostname resolves to must pass `isAddressAllowed`, enforced in
 * the connection's DNS hook. Redirects are followed by hand (at most
 * {@link MAX_REDIRECTS}) so each hop is re-checked, and the `Authorization`
 * header is sent only while the redirect stays on the source's origin.
 *
 * The cap is enforced twice: eagerly against a `content-length` response
 * header (fails fast without reading the body), and defensively while
 * streaming the body (a server that lies about `content-length`, or omits
 * it, is still cut off mid-stream once the cap is crossed).
 *
 * @throws {FetchSourceError} `forbidden_destination`, `timeout`,
 *   `http_status`, `size_limit_exceeded` or `network`.
 */
export async function fetchBanList(
  url: string,
  authHeader: string | null,
  opts: FetchBanListOptions = {},
): Promise<FetchBanListResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const isAddressAllowed = opts.isAddressAllowed ?? isPublicUnicastAddress;
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(opts.lookup ?? defaultResolveHost, isAddressAllowed) },
  });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await requestFollowingRedirects(url, authHeader, {
      isAddressAllowed,
      dispatcher,
      signal: controller.signal,
      timeoutMs,
    });
    return await readCappedBody(response, maxBytes, timeoutMs, started);
  } finally {
    clearTimeout(timer);
    await dispatcher.destroy().catch(() => undefined);
  }
}

async function requestFollowingRedirects(
  url: string,
  authHeader: string | null,
  ctx: {
    isAddressAllowed: (address: string) => boolean;
    dispatcher: Agent;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<Response> {
  let current = assertAllowedUrl(url, ctx.isAddressAllowed);
  const sourceOrigin = current.origin;
  for (let hop = 0; ; hop += 1) {
    const sendAuth = authHeader !== null && current.origin === sourceOrigin;
    let response: Response;
    try {
      response = await undiciFetch(current, {
        headers: sendAuth ? { Authorization: authHeader } : undefined,
        signal: ctx.signal,
        redirect: 'manual',
        dispatcher: ctx.dispatcher,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new FetchSourceError('timeout', `fetch timed out after ${ctx.timeoutMs}ms`);
      }
      const forbidden = findForbiddenAddress(err);
      if (forbidden) throw new FetchSourceError('forbidden_destination', forbidden.message);
      const cause = (err as { cause?: Error }).cause;
      throw new FetchSourceError('network', cause?.message ?? (err as Error).message);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (!location) {
      throw new FetchSourceError('http_status', `HTTP ${response.status} without a Location`);
    }
    if (hop >= MAX_REDIRECTS) {
      throw new FetchSourceError('http_status', `more than ${MAX_REDIRECTS} redirects`);
    }
    current = assertAllowedUrl(new URL(location, current).href, ctx.isAddressAllowed);
  }
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  started: number,
): Promise<FetchBanListResult> {
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
}
