import { describe, expect, it } from 'vitest';
import {
  findNonPublicAddress,
  isPublicAddress,
  OutboundUrlError,
  parseOutboundHttpUrl,
} from '../src/outbound-url.js';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002:a00:1::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
  ])('refuses the special-purpose address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2001:4860::8888'])(
    'accepts the public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('reports a non-IP string as not public', () => {
    expect(isPublicAddress('example.com')).toBe(false);
  });
});

describe('parseOutboundHttpUrl', () => {
  it('accepts http and https URLs on a hostname or a public IP', () => {
    expect(parseOutboundHttpUrl('https://bans.example.com/list.cfg').hostname).toBe(
      'bans.example.com',
    );
    expect(parseOutboundHttpUrl('http://93.184.216.34/list').hostname).toBe('93.184.216.34');
    expect(parseOutboundHttpUrl('http://[2606:4700:4700::1111]/').hostname).toBe(
      '[2606:4700:4700::1111]',
    );
  });

  it.each([
    ['not a url', 'invalid_url'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['ftp://example.com/bans', 'unsupported_scheme'],
    ['gopher://example.com/', 'unsupported_scheme'],
    ['http://localhost:3000/api', 'non_public_address'],
    ['http://LOCALHOST/', 'non_public_address'],
    ['http://api.localhost/', 'non_public_address'],
    ['http://127.0.0.1:6379/', 'non_public_address'],
    ['http://169.254.169.254/latest/meta-data/', 'non_public_address'],
    ['http://2130706433/', 'non_public_address'],
    ['http://[::1]:8080/', 'non_public_address'],
    ['http://[::ffff:10.0.0.1]/', 'non_public_address'],
  ])('refuses %s as %s', (raw, reason) => {
    let caught: unknown;
    try {
      parseOutboundHttpUrl(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundUrlError);
    expect(caught).toMatchObject({ name: 'OutboundUrlError', reason });
  });
});

describe('findNonPublicAddress', () => {
  it('returns null when every resolved address is public', async () => {
    const resolve = async () => [{ address: '93.184.216.34' }, { address: '2606:4700::1' }];
    await expect(findNonPublicAddress('bans.example.com', resolve)).resolves.toBeNull();
  });

  it('returns the first non-public address a hostname resolves to', async () => {
    const resolve = async () => [{ address: '93.184.216.34' }, { address: '172.18.0.5' }];
    await expect(findNonPublicAddress('api', resolve)).resolves.toBe('172.18.0.5');
  });

  it('returns null when the hostname cannot be resolved', async () => {
    const resolve = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(findNonPublicAddress('nowhere.invalid', resolve)).resolves.toBeNull();
  });

  it('checks an IP literal without resolving it', async () => {
    const resolve = async () => {
      throw new Error('must not resolve a literal');
    };
    await expect(findNonPublicAddress('10.0.0.1', resolve)).resolves.toBe('10.0.0.1');
    await expect(findNonPublicAddress('[::1]', resolve)).resolves.toBe('::1');
    await expect(findNonPublicAddress('1.1.1.1', resolve)).resolves.toBeNull();
  });

  it('resolves through the system resolver by default', async () => {
    await expect(findNonPublicAddress('localhost')).resolves.toMatch(/^(127\.0\.0\.1|::1)$/);
  });
});
