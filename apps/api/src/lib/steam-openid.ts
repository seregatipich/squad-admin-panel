const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_PREFIX = 'https://steamcommunity.com/openid/id/';

export interface BuildLoginRedirectUrlInput {
  panelPublicUrl: string;
  nonce: string;
}

export function buildLoginRedirectUrl(input: BuildLoginRedirectUrlInput): string {
  const base = input.panelPublicUrl.replace(/\/+$/, '');
  const returnTo = `${base}/api/v1/auth/steam/callback?n=${encodeURIComponent(input.nonce)}`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': `${base}/`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

export function parseClaimedSteamId64(claimedId: string): bigint {
  if (!claimedId.startsWith(CLAIMED_ID_PREFIX)) {
    throw new Error(`invalid claimed_id host: ${claimedId}`);
  }
  const tail = claimedId.slice(CLAIMED_ID_PREFIX.length);
  if (!/^\d{17}$/.test(tail)) {
    throw new Error(`invalid claimed_id format: ${claimedId}`);
  }
  return BigInt(tail);
}

export type CallbackParams = Record<string, string | undefined>;

export interface SteamVerifyResult {
  steamId64: bigint;
  responseNonce: string;
}

export interface VerifyDeps {
  fetch?: typeof fetch;
}

export async function verifyWithSteam(
  params: CallbackParams,
  deps: VerifyDeps = {},
): Promise<SteamVerifyResult> {
  const f = deps.fetch ?? fetch;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('openid.') && typeof v === 'string') body.set(k, v);
  }
  body.set('openid.mode', 'check_authentication');
  const res = await f(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`steam check_authentication HTTP ${res.status}`);
  const text = await res.text();
  const lines: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    lines[line.slice(0, idx)] = line.slice(idx + 1);
  }
  if (lines.is_valid !== 'true') {
    throw new Error(`steam is_valid=${lines.is_valid ?? 'missing'}`);
  }
  const claimedId = params['openid.claimed_id'];
  if (!claimedId) throw new Error('missing openid.claimed_id');
  const steamId64 = parseClaimedSteamId64(claimedId);
  const responseNonce = params['openid.response_nonce'];
  if (!responseNonce) throw new Error('missing openid.response_nonce');
  return { steamId64, responseNonce };
}
