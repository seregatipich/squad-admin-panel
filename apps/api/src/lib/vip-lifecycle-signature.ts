import { createHmac, timingSafeEqual } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function createVipLifecycleSignature(
  secret: string,
  timestamp: string,
  payload: unknown,
): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${canonicalJson(payload)}`)
    .digest('hex')}`;
}

export function verifyVipLifecycleSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  payload: unknown,
): boolean {
  if (!timestamp || !signature) return false;
  const expected = createVipLifecycleSignature(secret, timestamp, payload);
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
