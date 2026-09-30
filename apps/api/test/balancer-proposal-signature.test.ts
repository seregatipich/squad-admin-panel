import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createBalancerProposalSignature,
  verifyBalancerProposalSignature,
} from '../src/lib/balancer-proposal-signature.js';

const SECRET = 'balancer-webhook-test-secret-with-enough-entropy';
const TIMESTAMP = '2026-07-27T09:00:00.000Z';
/** The verifier's clock, 10 s after {@link TIMESTAMP}. */
const NOW = new Date('2026-07-27T09:00:10.000Z');

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
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD, NOW)).toBe(true);
  });

  it('accepts a bare hex signature without the sha256= prefix', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD).slice(
      'sha256='.length,
    );
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD, NOW)).toBe(true);
  });

  it('rejects a missing timestamp or a missing signature', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(verifyBalancerProposalSignature(SECRET, undefined, signature, PAYLOAD, NOW)).toBe(false);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, undefined, PAYLOAD, NOW)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const signature = createBalancerProposalSignature('other-secret', TIMESTAMP, PAYLOAD);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD, NOW)).toBe(false);
  });

  it('rejects a replayed signature bound to a different timestamp', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(
      verifyBalancerProposalSignature(SECRET, '2026-07-27T09:00:05.000Z', signature, PAYLOAD, NOW),
    ).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(
      verifyBalancerProposalSignature(
        SECRET,
        TIMESTAMP,
        signature,
        {
          ...PAYLOAD,
          source_snapshot_id: 'snap-2',
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length instead of throwing', () => {
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, 'sha256=abcd', PAYLOAD, NOW)).toBe(
      false,
    );
  });

  it('rejects a non-hex signature instead of throwing', () => {
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, 'sha256=zzzz', PAYLOAD, NOW)).toBe(
      false,
    );
  });

  it('rejects a validly signed request replayed after the freshness window (#36 finding 15)', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    const later = new Date(Date.parse(TIMESTAMP) + 301_000);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD, later)).toBe(
      false,
    );
    const atEdge = new Date(Date.parse(TIMESTAMP) + 300_000);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD, atEdge)).toBe(
      true,
    );
  });

  it('rejects a timestamp too far in the future', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    const earlier = new Date(Date.parse(TIMESTAMP) - 301_000);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD, earlier)).toBe(
      false,
    );
  });

  it('honours a custom tolerance', () => {
    const signature = createBalancerProposalSignature(SECRET, TIMESTAMP, PAYLOAD);
    expect(verifyBalancerProposalSignature(SECRET, TIMESTAMP, signature, PAYLOAD, NOW, 5)).toBe(
      false,
    );
  });

  it('rejects an unparseable timestamp even when the MAC matches', () => {
    const signature = createBalancerProposalSignature(SECRET, 'not-a-date', PAYLOAD);
    expect(verifyBalancerProposalSignature(SECRET, 'not-a-date', signature, PAYLOAD, NOW)).toBe(
      false,
    );
  });
});

describe('verifyBalancerProposalSignature timestamp formats', () => {
  const now = new Date(Date.parse(TIMESTAMP));
  const verifyAt = (timestamp: string) =>
    verifyBalancerProposalSignature(
      SECRET,
      timestamp,
      createBalancerProposalSignature(SECRET, timestamp, PAYLOAD),
      PAYLOAD,
      now,
    );

  it('accepts ISO and unix-second timestamps inside the ±5 minute window, edges included', () => {
    expect(verifyAt(TIMESTAMP)).toBe(true);
    expect(verifyAt(new Date(now.getTime() - 5 * 60_000).toISOString())).toBe(true);
    expect(verifyAt(new Date(now.getTime() + 5 * 60_000).toISOString())).toBe(true);
    expect(verifyAt(String(now.getTime() / 1000 - 60))).toBe(true);
  });

  it('rejects timestamps just outside the window in either direction', () => {
    expect(verifyAt(new Date(now.getTime() - 5 * 60_000 - 1).toISOString())).toBe(false);
    expect(verifyAt(new Date(now.getTime() + 5 * 60_000 + 1).toISOString())).toBe(false);
    expect(verifyAt(String(now.getTime() / 1000 - 3600))).toBe(false);
  });

  it('rejects missing and unparsable timestamps', () => {
    expect(verifyBalancerProposalSignature(SECRET, undefined, 'sha256=00', PAYLOAD, now)).toBe(
      false,
    );
    expect(verifyAt('yesterday')).toBe(false);
  });
});
