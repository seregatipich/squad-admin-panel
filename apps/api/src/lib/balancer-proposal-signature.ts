import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC signing for the GAME-2 (#81) inbound balancer-proposal webhook.
 *
 * The producer signs `"<timestamp>.<canonical JSON of the body>"` with a shared
 * secret and sends the digest in `x-balancer-signature` alongside `x-balancer-timestamp`.
 * Canonicalisation (recursively sorted object keys, array order preserved)
 * makes the digest independent of the producer's JSON key ordering. Binding
 * the timestamp into the MAC means a captured signature cannot be moved onto a
 * different timestamp, and {@link verifyBalancerProposalSignature} rejects a
 * timestamp outside {@link BALANCER_SIGNATURE_TOLERANCE_SECONDS} of the
 * receiver's clock, so a captured request can only be replayed within that
 * window (where a redelivery is idempotent on `source_snapshot_id` anyway).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Builds the `sha256=<hex>` signature a producer sends for `payload`. */
export function createBalancerProposalSignature(
  secret: string,
  timestamp: string,
  payload: unknown,
): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${canonicalJson(payload)}`)
    .digest('hex')}`;
}

/** Maximum clock distance, either direction, between the signed timestamp and now. */
export const BALANCER_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Constant-time check of a received signature that also enforces timestamp
 * freshness (replay protection, #36). Accepts the digest with or without the
 * `sha256=` prefix and returns `false` — never throws — for a missing header,
 * an unparseable timestamp, a timestamp more than `toleranceSeconds` away from
 * `now`, a malformed hex string or a length mismatch.
 *
 * @param secret - `BALANCER_WEBHOOK_SECRET`.
 * @param timestamp - The `x-balancer-timestamp` header (an ISO-8601 instant).
 * @param signature - The `x-balancer-signature` header.
 * @param payload - The parsed request body.
 * @param now - The receiver's clock; injectable for tests.
 * @param toleranceSeconds - Accepted skew/age window, inclusive.
 * @returns `true` only for a fresh timestamp and a matching MAC.
 */
export function verifyBalancerProposalSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  payload: unknown,
  now: Date = new Date(),
  toleranceSeconds: number = BALANCER_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (!timestamp || !signature) return false;
  const signedAtMs = Date.parse(timestamp);
  if (Number.isNaN(signedAtMs)) return false;
  if (Math.abs(now.getTime() - signedAtMs) > toleranceSeconds * 1000) return false;
  const expected = createBalancerProposalSignature(secret, timestamp, payload);
  const actualHex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expectedHex = expected.slice('sha256='.length);
  try {
    const actual = Buffer.from(actualHex, 'hex');
    const expectedBuffer = Buffer.from(expectedHex, 'hex');
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}
