import { describe, expect, it } from 'vitest';
import { externalServerConnectionUpdate, externalServerCreateInput } from '../src/api.js';
import { isRestrictedNetworkHost } from '../src/network-host.js';

describe('isRestrictedNetworkHost (#30, finding #333)', () => {
  it.each([
    '127.0.0.1',
    '127.8.9.10',
    '0.0.0.0',
    '169.254.169.254',
    '224.0.0.1',
    '255.255.255.255',
    'localhost',
    'LOCALHOST.',
    'api.localhost',
    'metadata.google.internal',
    'redis',
    'postgres',
    '127.1',
    '2130706433',
    '0x7f.0.0.1',
    '0177.0.0.1',
    '::1',
    '[::1]',
    '::',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    'fe80::1',
    'ff02::1',
    '1:2:3',
    ':::1',
  ])('refuses %s', (host) => {
    expect(isRestrictedNetworkHost(host)).toBe(true);
  });

  it.each([
    '203.0.113.10',
    '80.242.59.123',
    '10.0.0.5',
    '192.168.1.20',
    'squad.example.org',
    '[2001:db8::1]',
    '2001:db8::1',
    '::ffff:203.0.113.10',
    'fd00::10',
  ])('allows %s', (host) => {
    expect(isRestrictedNetworkHost(host)).toBe(false);
  });
});

describe('external server connection schemas refuse loopback and control characters', () => {
  const minimal = {
    display_name: 'SSRF probe',
    slug: 'ssrf-probe',
    rcon_host: '203.0.113.10',
    rcon_port: 21_114,
    rcon_password: 's3cret',
    query_port: 27_165,
  };

  it('refuses a loopback rcon_host aimed at a local service', () => {
    const create = externalServerCreateInput.safeParse({
      ...minimal,
      rcon_host: '127.0.0.1',
      rcon_port: 6379,
    });
    expect(create.success).toBe(false);
    expect(externalServerConnectionUpdate.safeParse({ rcon_host: 'localhost' }).success).toBe(
      false,
    );
  });

  it('refuses an rcon_password carrying CR, LF or NUL', () => {
    for (const rcon_password of ['x\r\nFLUSHALL\r\n', 'x\nSET a b', 'x\u0000y', 'x\u007fy']) {
      expect(externalServerCreateInput.safeParse({ ...minimal, rcon_password }).success).toBe(
        false,
      );
      expect(externalServerConnectionUpdate.safeParse({ rcon_password }).success).toBe(false);
    }
  });

  it('still accepts a printable password with spaces and symbols', () => {
    expect(
      externalServerCreateInput.safeParse({ ...minimal, rcon_password: 'p@ss w0rd!;"' }).success,
    ).toBe(true);
  });
});
