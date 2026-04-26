import { createHash } from 'node:crypto';
import type { PERMISSION_KEYS } from '@squad/shared-config';
import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_PREFIX,
  extractBearerToken,
  hashApiToken,
  intersectScopes,
  looksLikeApiToken,
  mintApiToken,
  validateScopesSubset,
} from '../src/lib/api-tokens.js';

describe('mintApiToken', () => {
  it('emits sqp_<uuid>_<random> with sha256 hash and matching id', () => {
    const minted = mintApiToken();
    expect(minted.plaintext.startsWith(API_TOKEN_PREFIX)).toBe(true);
    const rest = minted.plaintext.slice(API_TOKEN_PREFIX.length);
    const sep = rest.indexOf('_');
    const uuid = rest.slice(0, sep);
    const random = rest.slice(sep + 1);
    expect(uuid).toBe(minted.id);
    expect(/^[0-9a-f-]{36}$/i.test(uuid)).toBe(true);
    expect(random.length).toBeGreaterThanOrEqual(32);
    const expectedHash = createHash('sha256').update(minted.plaintext).digest('base64url');
    expect(minted.tokenHash).toBe(expectedHash);
  });

  it('produces unique tokens on every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const t = mintApiToken();
      expect(seen.has(t.plaintext)).toBe(false);
      seen.add(t.plaintext);
    }
  });
});

describe('hashApiToken', () => {
  it('is deterministic sha256 base64url', () => {
    expect(hashApiToken('sqp_x_y')).toBe(hashApiToken('sqp_x_y'));
    expect(hashApiToken('sqp_x_y')).not.toBe(hashApiToken('sqp_x_z'));
  });
});

describe('looksLikeApiToken', () => {
  it('accepts a freshly minted token', () => {
    expect(looksLikeApiToken(mintApiToken().plaintext)).toBe(true);
  });
  it.each([
    'plain',
    'sqp_no-uuid',
    'sqp_short_xx',
    'cookie_value',
    `${API_TOKEN_PREFIX}not-a-uuid_${'a'.repeat(32)}`,
  ])('rejects %s', (value) => {
    expect(looksLikeApiToken(value)).toBe(false);
  });
});

describe('validateScopesSubset', () => {
  const granted = new Set<(typeof PERMISSION_KEYS)[number]>([
    'server:view',
    'server:start',
    'server:stop',
  ]);

  it('passes when requested ⊆ granted', () => {
    const r = validateScopesSubset(['server:view', 'server:start'], granted);
    expect(r).toEqual({ ok: true, unknown: [], notGranted: [] });
  });

  it('flags unknown permission keys', () => {
    const r = validateScopesSubset(['server:view', 'made:up'], granted);
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(['made:up']);
    expect(r.notGranted).toEqual([]);
  });

  it('flags keys the caller does not have', () => {
    const r = validateScopesSubset(['server:view', 'server:delete'], granted);
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual([]);
    expect(r.notGranted).toEqual(['server:delete']);
  });

  it('treats empty requested set as ok', () => {
    expect(validateScopesSubset([], granted).ok).toBe(true);
  });
});

describe('intersectScopes', () => {
  it('returns only scopes both present and known', () => {
    const granted = new Set<(typeof PERMISSION_KEYS)[number]>(['server:view', 'audit:view']);
    const result = intersectScopes(['server:view', 'made:up', 'server:start'], granted);
    expect(Array.from(result).sort()).toEqual(['server:view']);
  });
});

describe('extractBearerToken', () => {
  it('parses Authorization header, trims scheme', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
  });
  it('returns null for missing or malformed input', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Token abc')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
  });
  it('handles array header (Node multi-value)', () => {
    expect(extractBearerToken(['Bearer first', 'Bearer second'])).toBe('first');
  });
});
