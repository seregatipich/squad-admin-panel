import { describe, expect, it, vi } from 'vitest';

import {
  buildAuthorizeUrl,
  buildRedirectUri,
  type DiscordUser,
  displayNameFor,
  exchangeCode,
  fetchDiscordUser,
} from '../src/lib/discord-oauth.js';

describe('buildRedirectUri', () => {
  it('appends the callback path to the panel public URL', () => {
    expect(buildRedirectUri('https://panel.example')).toBe(
      'https://panel.example/api/v1/auth/discord/callback',
    );
  });

  it('strips trailing slashes from the panel public URL', () => {
    expect(buildRedirectUri('https://panel.example///')).toBe(
      'https://panel.example/api/v1/auth/discord/callback',
    );
  });
});

describe('buildAuthorizeUrl', () => {
  it('targets the Discord authorize endpoint with the identify scope and the state', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'client-123',
        redirectUri: 'https://panel.example/api/v1/auth/discord/callback',
        state: 'state-abc',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://panel.example/api/v1/auth/discord/callback',
    );
  });
});

describe('exchangeCode', () => {
  const deps = {
    clientId: 'client-123',
    clientSecret: 'secret-456',
    redirectUri: 'https://panel.example/api/v1/auth/discord/callback',
  };

  it('returns null without ever calling Discord when the client id is missing', async () => {
    const f = vi.fn();
    const result = await exchangeCode('code-1', { ...deps, clientId: '', fetch: f as never });
    expect(result).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('returns null without ever calling Discord when the client secret is missing', async () => {
    const f = vi.fn();
    const result = await exchangeCode('code-1', { ...deps, clientSecret: '', fetch: f as never });
    expect(result).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the authorization_code grant with HTTP Basic credentials and form body', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok-1' })));
    const token = await exchangeCode('code-1', { ...deps, fetch: f as never });

    expect(token).toBe('tok-1');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/oauth2/token');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('client-123:secret-456').toString('base64')}`,
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('redirect_uri')).toBe(deps.redirectUri);
    expect(body.get('client_secret')).toBeNull();
  });

  it('throws when Discord rejects the exchange', async () => {
    const f = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(exchangeCode('code-1', { ...deps, fetch: f as never })).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it('throws when the token response carries no access_token', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ token_type: 'Bearer' })));
    await expect(exchangeCode('code-1', { ...deps, fetch: f as never })).rejects.toThrow(
      /access_token/,
    );
  });
});

describe('fetchDiscordUser', () => {
  it('sends the bearer token to the current-user endpoint and returns the identity', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: '111222333444555666',
            username: 'squaddie',
            global_name: 'Сквадди',
          }),
        ),
    );
    const user = await fetchDiscordUser('tok-1', { fetch: f as never });

    expect(user).toEqual({
      id: '111222333444555666',
      username: 'squaddie',
      global_name: 'Сквадди',
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/users/@me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('throws when the identity response has no id', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ username: 'squaddie' })));
    await expect(fetchDiscordUser('tok-1', { fetch: f as never })).rejects.toThrow(/id/);
  });

  it('throws when Discord rejects the identity request', async () => {
    const f = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    await expect(fetchDiscordUser('tok-1', { fetch: f as never })).rejects.toThrow(/HTTP 401/);
  });
});

describe('displayNameFor', () => {
  it('prefers the global display name when Discord provides one', () => {
    const user: DiscordUser = { id: '1', username: 'squaddie', global_name: 'Сквадди' };
    expect(displayNameFor(user)).toBe('Сквадди');
  });

  it('falls back to the username when global_name is null', () => {
    const user: DiscordUser = { id: '1', username: 'squaddie', global_name: null };
    expect(displayNameFor(user)).toBe('squaddie');
  });

  it('falls back to the raw id when neither name is usable', () => {
    const user: DiscordUser = { id: '1', username: '', global_name: null };
    expect(displayNameFor(user)).toBe('1');
  });
});
