import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLoginRedirectUrl,
  parseClaimedSteamId64,
  verifyWithSteam,
} from '../src/lib/steam-openid.js';

describe('buildLoginRedirectUrl', () => {
  it('builds the standard checkid_setup URL with return_to + realm', () => {
    const url = buildLoginRedirectUrl({
      panelPublicUrl: 'https://panel.example',
      nonce: 'abc123',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(u.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(u.searchParams.get('openid.return_to')).toBe(
      'https://panel.example/api/v1/auth/steam/callback?n=abc123',
    );
    expect(u.searchParams.get('openid.realm')).toBe('https://panel.example/');
    expect(u.searchParams.get('openid.identity')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
    expect(u.searchParams.get('openid.claimed_id')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
  });

  it('strips trailing slashes from panelPublicUrl', () => {
    const url = buildLoginRedirectUrl({
      panelPublicUrl: 'https://panel.example/',
      nonce: 'abc',
    });
    const u = new URL(url);
    expect(u.searchParams.get('openid.realm')).toBe('https://panel.example/');
    expect(u.searchParams.get('openid.return_to')).toBe(
      'https://panel.example/api/v1/auth/steam/callback?n=abc',
    );
  });

  it('encodes nonces with reserved characters', () => {
    const url = buildLoginRedirectUrl({
      panelPublicUrl: 'https://panel.example',
      nonce: 'a/b+c',
    });
    const u = new URL(url);
    expect(u.searchParams.get('openid.return_to')).toBe(
      'https://panel.example/api/v1/auth/steam/callback?n=a%2Fb%2Bc',
    );
  });
});

describe('parseClaimedSteamId64', () => {
  it('extracts the 17-digit id from a valid claimed_id', () => {
    expect(parseClaimedSteamId64('https://steamcommunity.com/openid/id/76561198000000001')).toBe(
      76561198000000001n,
    );
  });
  it('rejects wrong host', () => {
    expect(() => parseClaimedSteamId64('https://evil.example/openid/id/76561198000000001')).toThrow(
      /claimed_id/,
    );
  });
  it('rejects non-numeric id', () => {
    expect(() => parseClaimedSteamId64('https://steamcommunity.com/openid/id/abc')).toThrow(
      /claimed_id/,
    );
  });
  it('rejects wrong-length id', () => {
    expect(() => parseClaimedSteamId64('https://steamcommunity.com/openid/id/12345')).toThrow(
      /claimed_id/,
    );
  });
  it('rejects http instead of https', () => {
    expect(() =>
      parseClaimedSteamId64('http://steamcommunity.com/openid/id/76561198000000001'),
    ).toThrow(/claimed_id/);
  });
});

describe('verifyWithSteam', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns steam_id64 + response_nonce on is_valid:true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n',
    });
    const result = await verifyWithSteam(
      {
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'id_res',
        'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000002',
        'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002',
        'openid.return_to': 'https://panel.example/api/v1/auth/steam/callback?n=abc',
        'openid.response_nonce': '2026-04-25T12:00:00Zabc',
        'openid.assoc_handle': 'x',
        'openid.signed': 'signed,op_endpoint',
        'openid.sig': 'sig',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.steamId64).toBe(76561198000000002n);
    expect(result.responseNonce).toBe('2026-04-25T12:00:00Zabc');
  });

  it('POSTs check_authentication with all openid.* params', async () => {
    let capturedBody: URLSearchParams | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: unknown) => {
      capturedBody = (init as { body: URLSearchParams })?.body;
      return { ok: true, text: async () => 'is_valid:true\n' };
    });
    await verifyWithSteam(
      {
        'openid.mode': 'id_res',
        'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000003',
        'openid.response_nonce': 'nonce',
        'openid.sig': 'sig',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as unknown as URLSearchParams;
    expect(body.get('openid.mode')).toBe('check_authentication');
    expect(body.get('openid.sig')).toBe('sig');
    expect(body.get('openid.claimed_id')).toBe(
      'https://steamcommunity.com/openid/id/76561198000000003',
    );
  });

  it('throws on is_valid:false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'is_valid:false\n',
    });
    await expect(
      verifyWithSteam(
        {
          'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000002',
          'openid.response_nonce': 'x',
        },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/is_valid/);
  });

  it('throws on missing claimed_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'is_valid:true\n',
    });
    await expect(
      verifyWithSteam(
        { 'openid.response_nonce': 'x' },
        {
          fetch: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/claimed_id/);
  });

  it('throws on missing response_nonce', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'is_valid:true\n',
    });
    await expect(
      verifyWithSteam(
        {
          'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000002',
        },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/response_nonce/);
  });

  it('throws on non-200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
    });
    await expect(
      verifyWithSteam(
        {
          'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000002',
          'openid.response_nonce': 'x',
        },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});
