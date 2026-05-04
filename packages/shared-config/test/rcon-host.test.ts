import { describe, expect, it } from 'vitest';
import { resolveRconHost } from '../src/rcon-host.js';

describe('resolveRconHost', () => {
  it('returns the explicit value when credentials pin a host', () => {
    expect(resolveRconHost('10.0.0.42', { RCON_HOST_DEFAULT: 'host.docker.internal' })).toBe(
      '10.0.0.42',
    );
    expect(resolveRconHost('remote.example', {})).toBe('remote.example');
  });

  it('falls back to RCON_HOST_DEFAULT when the credential host is null', () => {
    expect(resolveRconHost(null, { RCON_HOST_DEFAULT: 'host.docker.internal' })).toBe(
      'host.docker.internal',
    );
    expect(resolveRconHost(undefined, { RCON_HOST_DEFAULT: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('falls back to 127.0.0.1 when neither creds nor env supply a host', () => {
    expect(resolveRconHost(null, {})).toBe('127.0.0.1');
    expect(resolveRconHost(undefined, {})).toBe('127.0.0.1');
  });

  it('treats empty-string creds like null so accidental "" does not break resolution', () => {
    expect(resolveRconHost('', { RCON_HOST_DEFAULT: 'host.docker.internal' })).toBe(
      'host.docker.internal',
    );
    expect(resolveRconHost('', {})).toBe('127.0.0.1');
  });

  it('prefers credsHost when explicitly set, even if env is populated', () => {
    expect(resolveRconHost('pinned.host', { RCON_HOST_DEFAULT: 'ignored.internal' })).toBe(
      'pinned.host',
    );
  });

  it('reads from process.env when env arg is omitted', () => {
    const previous = process.env.RCON_HOST_DEFAULT;
    process.env.RCON_HOST_DEFAULT = 'env-default.internal';
    try {
      expect(resolveRconHost(null)).toBe('env-default.internal');
    } finally {
      if (previous === undefined) delete process.env.RCON_HOST_DEFAULT;
      else process.env.RCON_HOST_DEFAULT = previous;
    }
  });
});
