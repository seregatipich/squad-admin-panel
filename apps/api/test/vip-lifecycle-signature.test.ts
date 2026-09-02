import { describe, expect, it } from 'vitest';
import {
  createVipLifecycleSignature,
  verifyVipLifecycleSignature,
} from '../src/lib/vip-lifecycle-signature.js';

const SECRET = 'vip-lifecycle-test-secret-with-enough-entropy';
const PAYLOAD = { event_id: 'vip-purchase-001' };
const NOW_MS = Date.parse('2026-09-02T20:00:00.000Z');

function verify(timestamp: string, nowMs = NOW_MS): boolean {
  return verifyVipLifecycleSignature(
    SECRET,
    timestamp,
    createVipLifecycleSignature(SECRET, timestamp, PAYLOAD),
    PAYLOAD,
    nowMs,
  );
}

describe('verifyVipLifecycleSignature', () => {
  it.each([
    '2026-09-02T20:00:00.000Z',
    '2026-09-02T19:55:00.000Z',
    '2026-09-02T20:05:00.000Z',
    '2026-09-02T23:00:00.000+03:00',
  ])('accepts a valid signature inside the inclusive freshness window: %s', (timestamp) => {
    expect(verify(timestamp)).toBe(true);
  });

  it.each(['2026-09-02T19:54:59.000Z', '2026-09-02T20:05:01.000Z'])(
    'rejects a valid signature outside the freshness window: %s',
    (timestamp) => {
      expect(verify(timestamp)).toBe(false);
    },
  );

  it.each([
    '2026-09-02T20:00:00.000',
    '2026-02-30T20:00:00.000Z',
    '2026-09-02T20:00:00.000+24:00',
    'not-an-iso-date',
  ])('rejects an invalid or timezone-less timestamp: %s', (timestamp) => {
    expect(verify(timestamp)).toBe(false);
  });

  it('rejects an invalid signature inside the freshness window', () => {
    expect(
      verifyVipLifecycleSignature(
        SECRET,
        '2026-09-02T20:00:00.000Z',
        'sha256=bad',
        PAYLOAD,
        NOW_MS,
      ),
    ).toBe(false);
  });
});
