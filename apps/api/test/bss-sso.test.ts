import { describe, expect, it, vi } from 'vitest';
import {
  BssSsoClient,
  BssSsoError,
  buildBssAuthorizeUrl,
  pkceChallenge,
} from '../src/lib/bss-sso.js';

const CONFIG = {
  siteUrl: 'https://bss.games',
  panelPublicUrl: 'https://panel.example',
  clientId: 'squad-admin-panel',
  clientSecret: 's'.repeat(32),
};

describe('BSS SSO protocol', () => {
  it('uses the RFC 7636 S256 vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('builds the exact allowlisted authorize request', () => {
    const url = new URL(
      buildBssAuthorizeUrl({
        ...CONFIG,
        state: 'state_01234567890123456789012345678901',
        codeVerifier: 'verifier_01234567890123456789012345678901234',
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe('https://bss.games/auth/sso/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'squad-admin-panel',
      redirect_uri: 'https://panel.example/api/v1/auth/bss/callback',
      state: 'state_01234567890123456789012345678901',
      code_challenge: pkceChallenge('verifier_01234567890123456789012345678901234'),
      code_challenge_method: 'S256',
    });
  });

  it('exchanges a code server-to-server and accepts only the minimal identity', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        steam_id64: '76561198000000001',
        canonical_name: 'Patrego',
        avatar_url: 'https://cdn.example/avatar.jpg',
      }),
    );
    const client = new BssSsoClient({ ...CONFIG, fetchImpl });

    const identity = await client.exchangeCode({
      code: 'one-time-code',
      codeVerifier: 'verifier_01234567890123456789012345678901234',
    });

    expect(identity).toEqual({
      steamId64: 76561198000000001n,
      canonicalName: 'Patrego',
      avatarUrl: 'https://cdn.example/avatar.jpg',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://bss.games/api/v1/auth/sso/token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: 'squad-admin-panel',
      client_secret: 's'.repeat(32),
      code: 'one-time-code',
      redirect_uri: 'https://panel.example/api/v1/auth/bss/callback',
      code_verifier: 'verifier_01234567890123456789012345678901234',
    });
  });

  it.each([
    {
      steam_id64: '76561198000000001',
      canonical_name: 'Patrego',
      avatar_url: null,
      extra: true,
    },
    { steam_id64: 'not-steam', canonical_name: 'Patrego', avatar_url: null },
    { steam_id64: '76561198000000001', canonical_name: '', avatar_url: null },
  ])('rejects a malformed or extended identity response', async (payload) => {
    const client = new BssSsoClient({
      ...CONFIG,
      fetchImpl: async () => Response.json(payload),
    });

    await expect(
      client.exchangeCode({
        code: 'sentinel-secret-code',
        codeVerifier: 'verifier_01234567890123456789012345678901234',
      }),
    ).rejects.toThrow(BssSsoError);
  });

  it('rejects a response larger than the bounded contract', async () => {
    const client = new BssSsoClient({
      ...CONFIG,
      fetchImpl: async () =>
        new Response(JSON.stringify({ value: 'x'.repeat(20_000) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(
      client.exchangeCode({
        code: 'oversized-code',
        codeVerifier: 'verifier_01234567890123456789012345678901234',
      }),
    ).rejects.toThrow(BssSsoError);
  });

  it('sets a timeout signal and refuses redirects', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ detail: 'rejected' }, { status: 400 });
    });
    const client = new BssSsoClient({ ...CONFIG, fetchImpl, timeoutMs: 50 });

    await expect(
      client.exchangeCode({
        code: 'sentinel-code-never-log',
        codeVerifier: 'sentinel-verifier-never-log-012345678901234567890',
      }),
    ).rejects.toMatchObject({ message: 'bss_sso_failed' });
    await expect(
      client.exchangeCode({
        code: 'sentinel-code-never-log',
        codeVerifier: 'sentinel-verifier-never-log-012345678901234567890',
      }),
    ).rejects.not.toThrow(/sentinel/u);
  });

  it('uses the strict trusted contract for site-wide logout', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = new BssSsoClient({ ...CONFIG, fetchImpl });

    await expect(client.revokeAllSiteSessions('76561198000000001')).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://bss.games/api/v1/auth/sso/logout-all');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: 'squad-admin-panel',
      client_secret: 's'.repeat(32),
      steam_id64: '76561198000000001',
    });
  });

  it.each([
    ['server error', async () => new Response(null, { status: 502 })],
    ['network error', async () => Promise.reject(new Error('site unavailable'))],
  ])('retries a retryable %s once and no more', async (_case, failure) => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(failure)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new BssSsoClient({ ...CONFIG, fetchImpl });

    await expect(client.revokeAllSiteSessions('76561198000000001')).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not immediately retry a rate-limited site', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 429 }));
    const client = new BssSsoClient({ ...CONFIG, fetchImpl });

    await expect(client.revokeAllSiteSessions('76561198000000001')).resolves.toBe(false);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
