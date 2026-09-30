import { describe, expect, it } from 'vitest';
import {
  isPrivateHostAllowed,
  isPrivateNetworkAddress,
  parsePrivateHostAllowlist,
} from '../src/network-host.js';

describe('isPrivateNetworkAddress (#30, finding #333)', () => {
  it.each([
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.20',
    '100.64.0.1',
    'fd00::1',
    'fc00::1',
    '[fdab:1::2]',
    '::ffff:10.0.0.5',
  ])('%s is a private LAN address', (host) => {
    expect(isPrivateNetworkAddress(host)).toBe(true);
  });

  it.each([
    '203.0.113.10',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '2001:db8::1',
    'squad.example.com',
    '::ffff:8.8.8.8',
    'fd00::zz',
    '[1:2:3]',
  ])('%s is not private (hostnames are checked after resolution)', (host) => {
    expect(isPrivateNetworkAddress(host)).toBe(false);
  });
});

describe('parsePrivateHostAllowlist', () => {
  it('treats unset and blank as unrestricted', () => {
    expect(parsePrivateHostAllowlist(undefined)).toBeNull();
    expect(parsePrivateHostAllowlist('')).toBeNull();
    expect(parsePrivateHostAllowlist('  ')).toBeNull();
  });

  it('treats "none" as an empty allowlist', () => {
    expect(parsePrivateHostAllowlist('none')).toEqual([]);
    expect(parsePrivateHostAllowlist(' NONE ')).toEqual([]);
  });

  it('accepts CIDRs and single addresses, comma separated', () => {
    expect(parsePrivateHostAllowlist('192.168.10.0/24, 10.1.2.3, fd00:1::/32')).toHaveLength(3);
  });

  it.each([
    'nonsense',
    '10.0.0.0/33',
    '10.0.0.0/-1',
    '10.0.0/24',
    'fd00::/129',
    '10.0.0.0/24,,',
    'squad.example.com',
  ])('rejects the malformed entry %s', (raw) => {
    expect(() => parsePrivateHostAllowlist(raw)).toThrow();
  });
});

describe('isPrivateHostAllowed', () => {
  it('allows every host when unrestricted (previous behaviour)', () => {
    expect(isPrivateHostAllowed('192.168.1.20', null)).toBe(true);
    expect(isPrivateHostAllowed('10.0.0.5', null)).toBe(true);
  });

  it('refuses every private address for an empty allowlist but keeps public hosts', () => {
    expect(isPrivateHostAllowed('192.168.1.20', [])).toBe(false);
    expect(isPrivateHostAllowed('fd00::1', [])).toBe(false);
    expect(isPrivateHostAllowed('203.0.113.10', [])).toBe(true);
    expect(isPrivateHostAllowed('squad.example.com', [])).toBe(true);
  });

  it('allows only the listed private ranges', () => {
    const allowlist = parsePrivateHostAllowlist('192.168.10.0/24,10.1.2.3,fd00:1::/32');
    expect(isPrivateHostAllowed('192.168.10.77', allowlist)).toBe(true);
    expect(isPrivateHostAllowed('192.168.11.1', allowlist)).toBe(false);
    expect(isPrivateHostAllowed('10.1.2.3', allowlist)).toBe(true);
    expect(isPrivateHostAllowed('10.1.2.4', allowlist)).toBe(false);
    expect(isPrivateHostAllowed('fd00:1::5', allowlist)).toBe(true);
    expect(isPrivateHostAllowed('fd00:2::5', allowlist)).toBe(false);
    expect(isPrivateHostAllowed('::ffff:192.168.10.77', allowlist)).toBe(true);
  });
});
