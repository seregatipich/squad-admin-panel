import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isPublicAddress, OutboundUrlError, parseOutboundHttpUrl } from '@squad/shared-config';
import { Agent, fetch as undiciFetch } from 'undici';

export const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.BAN_SYNC_FETCH_TIMEOUT_MS ?? 30_000);
export const DEFAULT_MAX_BYTES = Number(process.env.BAN_SYNC_MAX_BYTES ?? 20 * 1024 * 1024);
/** Redirect hops followed (each one re-validated) before the fetch gives up. */
export const MAX_REDIRECTS = 5;

export type FetchSourceErrorReason =
  | 'timeout'
  | 'http_status'
  | 'size_limit_exceeded'
  | 'network'
  | 'forbidden_url';

export class FetchSourceError extends Error {
  readonly reason: FetchSourceErrorReason;

  constructor(reason: FetchSourceErrorReason, message: string) {
    super(message);
    this.name = 'FetchSourceError';
    this.reason = reason;
  }
}

/**
 * A `net.connect` lookup that refuses to connect to a non-public address
 * (#855). Checking inside the connect path, instead of resolving once before
 * the request, leaves no window for a DNS answer that changes between the
 * check and the connection (DNS rebinding). IP-literal hosts never reach a
 * lookup, which is why `fetchBanList` also checks every URL it requests with
 * `parseOutboundHttpUrl`.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(
    hostname,
    { ...(options as LookupOptions), all: true },
    (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
      if (blocked) {
        const refused = new OutboundUrlError(
          'non_public_address',
          `host ${hostname} resolves to non-public address ${blocked.address}`,
        );
        callback(refused as NodeJS.ErrnoException, '', 0);
        return;
      }
      if ((options as LookupOptions).all) {
        (callback as unknown as (e: null, all: LookupAddress[]) => void)(null, addresses);
        return;
      }
      const [first] = addresses as [LookupAddress];
      callback(null, first.address, first.family);
    },
  );
};

const publicOnlyAgent = new Agent({ connect: { lookup: publicOnlyLookup } });

/** The production fetch: undici's `fetch` over the public-only agent. */
const publicOnlyFetch = ((input: string, init?: RequestInit) =>
  undiciFetch(input, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: publicOnlyAgent,
  })) as unknown as typeof fetch;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function refusedBy(err: unknown): OutboundUrlError | null {
  if (err instanceof OutboundUrlError) return err;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof OutboundUrlError ? cause : null;
}

export interface FetchBanListResult {
  text: string;
  bytes: number;
  durationMs: number;
}

export interface FetchBanListOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Injectable for tests; defaults to undici's `fetch` over an agent that
   * refuses non-public addresses at connect time.
   */
  fetchImpl?: typeof fetch;
  /**
   * Skips the public-address checks and uses the global `fetch`. Only tests
   * that serve a list from a local server set this; the worker never does.
   */
  allowPrivateAddresses?: boolean;
}

/**
 * Downloads a ban-list source with a hard timeout and a hard byte cap.
 *
 * Only `http:`/`https:` URLs on public addresses are fetched (#855): every URL
 * requested, including each redirect target (followed manually, at most
 * `MAX_REDIRECTS` hops), is checked with `parseOutboundHttpUrl`, and the
 * default fetch refuses at connect time a hostname resolving to a non-public
 * address. The `Authorization` header is dropped as soon as a redirect leaves
 * the source's origin. A refused URL rejects with reason `forbidden_url`.
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
  const allowPrivate = opts.allowPrivateAddresses === true;
  const doFetch = opts.fetchImpl ?? (allowPrivate ? fetch : publicOnlyFetch);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  let target = url;
  let auth = authHeader;
  try {
    for (let hop = 0; ; hop++) {
      const current = allowPrivate ? new URL(target) : parseOutboundHttpUrl(target);
      response = await doFetch(current.href, {
        headers: auth ? { Authorization: auth } : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (!isRedirect(response.status) || !location) break;
      if (hop >= MAX_REDIRECTS) {
        throw new FetchSourceError('http_status', `more than ${MAX_REDIRECTS} redirects`);
      }
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, current);
      if (next.origin !== current.origin) auth = null;
      target = next.href;
    }
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof FetchSourceError) throw err;
    const refused = refusedBy(err);
    if (refused) throw new FetchSourceError('forbidden_url', refused.message);
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
