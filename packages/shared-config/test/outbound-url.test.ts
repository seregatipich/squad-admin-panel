import { describe, expect, it } from 'vitest';
import { checkOutboundUrl, isPublicUnicastAddress } from '../src/outbound-url.js';

describe('isPublicUnicastAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.5',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.10',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('rejects the non-public IPv4 address %s', (address) => {
    expect(isPublicUnicastAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1'])(
    'accepts the public IPv4 address %s',
    (address) => {
      expect(isPublicUnicastAddress(address)).toBe(true);
    },
  );

  it.each([
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:0101::1',
    '2001:db8::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    'fe80::1%eth0',
  ])('rejects the non-public IPv6 address %s', (address) => {
    expect(isPublicUnicastAddress(address)).toBe(false);
  });

  it.each([
    '2606:4700:4700::1111',
    '2a00:1450:4001:82a::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('accepts the public IPv6 address %s', (address) => {
    expect(isPublicUnicastAddress(address)).toBe(true);
  });

  it.each([
    '',
    'example.com',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1::2::3',
    'gggg::1',
    '1:2:3:4:5:6:7:8:9',
  ])('rejects the malformed address %j', (address) => {
    expect(isPublicUnicastAddress(address)).toBe(false);
  });
});

describe('checkOutboundUrl', () => {
  it.each([
    'https://collabans.example.com/bans.cfg',
    'http://bans.example.org:8080/list.json',
    'https://8.8.8.8/bans',
    'https://[2606:4700:4700::1111]/bans',
    'https://bans.example.com./list',
  ])('accepts %s', (raw) => {
    const result = checkOutboundUrl(raw);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not a url', 'invalid_url'],
    ['ftp://bans.example.com/list', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['https://user:pass@bans.example.com/list', 'credentials_in_url'],
    ['http://redis:6379/', 'internal_host'],
    ['http://postgres:5432/', 'internal_host'],
    ['http://api:3000/api/v1/me', 'internal_host'],
    ['http://localhost:3000/', 'internal_host'],
    ['http://panel.localhost/', 'internal_host'],
    ['http://printer.local/', 'internal_host'],
    ['http://metadata.google.internal/', 'internal_host'],
    ['http://router.home.arpa/', 'internal_host'],
    ['http://127.0.0.1:6379/', 'forbidden_address'],
    ['http://0x7f.0.0.1/', 'forbidden_address'],
    ['http://2130706433/', 'forbidden_address'],
    ['http://169.254.169.254/latest/meta-data/', 'forbidden_address'],
    ['http://10.0.0.8/', 'forbidden_address'],
    ['http://[::1]/', 'forbidden_address'],
    ['http://[::ffff:127.0.0.1]/', 'forbidden_address'],
  ])('rejects %s as %s', (raw, reason) => {
    expect(checkOutboundUrl(raw)).toEqual({ ok: false, reason });
  });
});
