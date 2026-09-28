import { describe, expect, it } from 'vitest';
import { isValidIpOrCidr } from '../src/lib/ip-cidr.js';

describe('isValidIpOrCidr', () => {
  it.each(['10.0.0.5', '10.0.0.0/8', '2001:db8::1', '2001:db8::/32', '::1', '::/0'])(
    'accepts %s',
    (value) => {
      expect(isValidIpOrCidr(value)).toBe(true);
    },
  );

  it.each([
    ['a host bit set under the mask', '10.0.0.1/8'],
    ['an IPv6 zone id, which Postgres cidr rejects (#66)', 'fe80::1%eth0'],
    ['a bare IPv4-mapped IPv6 address, as the JSDoc promises (#66)', '::ffff:192.0.2.1'],
    ['surrounding whitespace; the schema trims before validating (#66)', ' 10.0.0.5 '],
    ['garbage', 'abc'],
  ])('rejects %s', (_label, value) => {
    expect(isValidIpOrCidr(value)).toBe(false);
  });
});
