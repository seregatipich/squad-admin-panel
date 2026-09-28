import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createBalancerProposalSignature,
  isBalancerTimestampFresh,
  verifyBalancerProposalSignature,
} from '../src/lib/balancer-proposal-signature.js';

const SECRET = 'balancer-webhook-test-secret-with-enough-entropy';
const TIMESTAMP = '2026-07-27T09:00:00.000Z';

const PAYLOAD = {
  source_snapshot_id: 'snap-1',
  mode: 'squad',
  signals: { win_streak: 4, ticket_diff: 320 },
  proposal: [{ subject_id: 'sq-1', state: 'should_move' }],
};

describe('canonicalJson', () => {
  it('sorts object keys so producer key order does not change the digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('preserves array order and serializes primitives verbatim', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
  });

  it('canonicalizes nested objects recursively', () => {
    expect(canonicalJson({ outer: { z: 1, a: [{ y: 1, x: 2 }] } })).toBe(
      '{"outer":{"a":[{"x":2,"y":1}],"z":1}}',
    );
  });
});

describe('createBalancerProposalSignature', () => {
  it('produces the sha256=<hex> HMAC over "<timestamp>.<canonical payload>"', () => {
    const expected = `sha256=${createHmac('sha256', SECRET)
      .update(`${TIMESTAMP}.${canonicalJson(PAYLOAD)}`)
      .digest('hex')}`;
    expect(createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD)).toBe(expected);
  });
});

describe('verifyBalancerProposalSignature', () => {
  it('accepts a signature produced by createBalancerProposalSignature', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD)).toBe(true);
  });

  it('accepts a bare hex signature without the sha256= prefix', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD).slice(
      'sha256='.length,
    );
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD)).toBe(true);
  });

  it('rejects a missing timestamp or a missing signature', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(verifyBalancerProposalSignature(SECRET, undefined, signature, PAYLOAD)).toBe(false);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, undefined, PAYLOAD)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const signature = createBalancerProposalSignature('other-secret', TIMESTAMP, PAYLOAD);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD)).toBe(false);
  });

  it('rejects a replayed signature bound to a different timestamp', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(
      verifyBalancerProposalSignature(SECRET, '2026-07-27T10:00:00.000Z', signature, PAYLOAD),
    ).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(
      verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, {
        ...PAYLOAD,
        source_snapshot_id: 'snap-2',
      }),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length instead of throwing', () => {
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, 'sha256=abcd', PAYLOAD)).toBe(false);
  });

  it('rejects a non-hex signature instead of throwing', () => {
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, 'sha256=zzzz', PAYLOAD)).toBe(false);
  });
});

describe('isBalancerTimestampFresh', () => {
  const now = Date.parse(TIMESTAMP);

  it('accepts ISO and unix-second timestamps inside the ±5 minute window, edges included', () => {
    expect(isBalancerTimestampFresh(TIMESTAMP, now)).toBe(true);
    expect(isBalancerTimestampFresh(new Date(now - 5 * 60_000).toISOString(), now)).toBe(true);
    expect(isBalancerTimestampFresh(new Date(now + 5 * 60_000).toISOString(), now)).toBe(true);
    expect(isBalancerTimestampFresh(String(now / 1000 - 60), now)).toBe(true);
  });

  it('rejects timestamps just outside the window in either direction', () => {
    expect(isBalancerTimestampFresh(new Date(now - 5 * 60_000 - 1).toISOString(), now)).toBe(false);
    expect(isBalancerTimestampFresh(new Date(now + 5 * 60_000 + 1).toISOString(), now)).toBe(false);
    expect(isBalancerTimestampFresh(String(now / 1000 - 3600), now)).toBe(false);
  });

  it('rejects missing and unparsable timestamps', () => {
    expect(isBalancerTimestampFresh(undefined, now)).toBe(false);
    expect(isBalancerTimestampFresh('', now)).toBe(false);
    expect(isBalancerTimestampFresh('yesterday', now)).toBe(false);
  });
});
