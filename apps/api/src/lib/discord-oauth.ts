/**
 * Discord OAuth2 authorization-code helpers for the account-link flow
 * (DISCORD-4, issue #151). Deliberately dependency-free: the repository talks
 * to Discord over raw `fetch` (see `apps/workers/discord/src/sender.ts`), so
 * this module only shapes the two HTTP calls the callback needs.
 *
 * Endpoints and the credential-passing scheme follow the current Discord
 * documentation (https://docs.discord.com/developers/topics/oauth2): the token
 * exchange is a form-encoded POST authenticated with **HTTP Basic**, never with
 * the client secret in the body.
 */

const AUTHORIZE_ENDPOINT = 'https://discord.com/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';
const CURRENT_USER_ENDPOINT = 'https://discord.com/api/users/@me';

/** Only the identity is requested — no guilds, no email. */
export const DISCORD_OAUTH_SCOPE = 'identify';

/** Path the Discord application must have registered as its redirect URI. */
export const DISCORD_CALLBACK_PATH = '/api/v1/auth/discord/callback';

/** Subset of the Discord user object the link flow consumes. */
export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
}

export interface BuildAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
}

export interface ExchangeCodeDeps {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface FetchDiscordUserDeps {
  fetch?: typeof fetch;
}

/**
 * Builds the absolute callback URL from the panel's public origin. Must match
 * the redirect URI registered on the Discord application byte for byte —
 * Discord rejects the exchange otherwise.
 */
export function buildRedirectUri(panelPublicUrl: string): string {
  return `${panelPublicUrl.replace(/\/+$/, '')}${DISCORD_CALLBACK_PATH}`;
}

/** Builds the Discord consent-screen URL the login route redirects the browser to. */
export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    scope: DISCORD_OAUTH_SCOPE,
    state: input.state,
    redirect_uri: input.redirectUri,
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * Trades an authorization code for an access token.
 *
 * Returns `null` — without contacting Discord at all — when the deployment has
 * no client credentials configured, mirroring `fetchSteamProfile`'s
 * `if (!deps.apiKey) return null` guard so an unconfigured panel degrades
 * instead of emitting a doomed request.
 *
 * @throws when Discord answers non-2xx or omits `access_token`.
 */
export async function exchangeCode(code: string, deps: ExchangeCodeDeps): Promise<string | null> {
  if (!deps.clientId || !deps.clientSecret) return null;
  const f = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: deps.redirectUri,
  });
  const basic = Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString('base64');
  const res = await f(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`discord token exchange HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: unknown };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('discord token response missing access_token');
  }
  return json.access_token;
}

/**
 * Reads the authorizing user's identity with the freshly issued access token.
 *
 * @throws when Discord answers non-2xx or the payload carries no usable `id`.
 */
export async function fetchDiscordUser(
  accessToken: string,
  deps: FetchDiscordUserDeps = {},
): Promise<DiscordUser> {
  const f = deps.fetch ?? fetch;
  const res = await f(CURRENT_USER_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`discord users/@me HTTP ${res.status}`);
  const json = (await res.json()) as {
    id?: unknown;
    username?: unknown;
    global_name?: unknown;
  };
  if (typeof json.id !== 'string' || json.id.length === 0) {
    throw new Error('discord users/@me response missing id');
  }
  return {
    id: json.id,
    username: typeof json.username === 'string' ? json.username : '',
    global_name: typeof json.global_name === 'string' ? json.global_name : null,
  };
}

/**
 * Picks the name stored as the link snapshot: Discord's display name when set,
 * otherwise the handle, otherwise the raw snowflake so the column is never empty.
 */
export function displayNameFor(user: DiscordUser): string {
  if (user.global_name && user.global_name.length > 0) return user.global_name;
  if (user.username.length > 0) return user.username;
  return user.id;
}
