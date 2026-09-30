import 'server-only';
import { headers } from 'next/headers';

/**
 * Headers that carry the visitor's address on a server-side API call.
 *
 * Server Components reach the API directly from the web container, so without
 * this every SSR request arrives with the container's address and all
 * anonymous visitors share one per-IP rate-limit bucket (`PUBLIC_RATE_LIMIT`
 * on the public routes). Caddy sets `X-Forwarded-For` to the real client
 * address on the request it proxies to `web` (it ignores any client-supplied
 * value because no `trusted_proxies` are configured), and the API runs with
 * `trustProxy: true`, so relaying that header makes `req.ip` the visitor again.
 *
 * @returns A `HeadersInit` with `x-forwarded-for`, or an empty object when the
 *   incoming request carries none (e.g. a direct hit on the web container).
 */
export async function forwardedClientHeaders(): Promise<Record<string, string>> {
  const forwardedFor = (await headers()).get('x-forwarded-for');
  return forwardedFor ? { 'x-forwarded-for': forwardedFor } : {};
}
