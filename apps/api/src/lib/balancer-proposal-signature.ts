import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC signing for the GAME-2 (#81) inbound balancer-proposal webhook.
 *
 * The producer signs `"<timestamp>.<canonical JSON of the body>"` with a shared
 * secret and sends the digest in `x-balancer-signature` alongside `x-balancer-timestamp`.
 * Canonicalisation (recursively sorted object keys, array order preserved)
 * makes the digest independent of the producer's JSON key ordering, and
 * binding the timestamp into the MAC means a captured signature cannot be
 * replayed under a different one.
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

/**
 * Constant-time check of a received signature. Accepts the digest with or
 * without the `sha256=` prefix and returns `false` — never throws — for a
 * missing header, a malformed hex string or a length mismatch.
 */
export function verifyBalancerProposalSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  payload: unknown,
): boolean {
  if (!timestamp || !signature) return false;
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
