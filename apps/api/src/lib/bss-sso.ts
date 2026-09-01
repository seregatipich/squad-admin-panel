import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_RESPONSE_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 2_000;
const LOGOUT_RETRY_DELAY_MIN_MS = 100;
const LOGOUT_RETRY_DELAY_JITTER_MS = 150;
const STATE_RE = /^[A-Za-z0-9._~-]{32,512}$/u;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/u;
const STEAM_ID64_RE = /^\d{17}$/u;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BssSsoClientOptions {
  siteUrl: string;
  panelPublicUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface BssIdentity {
  steamId64: bigint;
  canonicalName: string;
  avatarUrl: string | null;
}

const identitySchema = z
  .object({
    steam_id64: z.string().regex(STEAM_ID64_RE),
    canonical_name: z.string().min(1).max(128),
    avatar_url: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => new URL(value).protocol === 'https:')
      .nullable(),
  })
  .strict();

const okSchema = z.object({ ok: z.literal(true) }).strict();

export class BssSsoError extends Error {
  constructor(readonly retryable = false) {
    super('bss_sso_failed');
    this.name = 'BssSsoError';
  }
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new BssSsoError();
  }
  return url.origin;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildBssAuthorizeUrl(input: {
  siteUrl: string;
  panelPublicUrl: string;
  clientId: string;
  state: string;
  codeVerifier: string;
}): string {
  if (!input.clientId || !STATE_RE.test(input.state) || !VERIFIER_RE.test(input.codeVerifier)) {
    throw new BssSsoError();
  }
  const callbackUrl = `${exactOrigin(input.panelPublicUrl)}/api/v1/auth/bss/callback`;
  const url = new URL('/auth/sso/authorize', exactOrigin(input.siteUrl));
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: callbackUrl,
    state: input.state,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) throw new BssSsoError();
  if (!response.body) throw new BssSsoError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new BssSsoError();
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new BssSsoError();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BssSsoError();
  }
}

export class BssSsoClient {
  private readonly siteUrl: string;
  private readonly callbackUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: BssSsoClientOptions) {
    this.siteUrl = exactOrigin(options.siteUrl);
    this.callbackUrl = `${exactOrigin(options.panelPublicUrl)}/api/v1/auth/bss/callback`;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<BssIdentity> {
    if (!input.code || !VERIFIER_RE.test(input.codeVerifier)) throw new BssSsoError();
    const payload = await this.post('/api/v1/auth/sso/token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: input.code,
      redirect_uri: this.callbackUrl,
      code_verifier: input.codeVerifier,
    });
    const identity = identitySchema.safeParse(payload);
    if (!identity.success) throw new BssSsoError();
    return {
      steamId64: BigInt(identity.data.steam_id64),
      canonicalName: identity.data.canonical_name,
      avatarUrl: identity.data.avatar_url,
    };
  }

  async revokeAllSiteSessions(steamId64: string): Promise<boolean> {
    if (!STEAM_ID64_RE.test(steamId64)) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const payload = await this.post('/api/v1/auth/sso/logout-all', {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          steam_id64: steamId64,
        });
        return okSchema.safeParse(payload).success;
      } catch (error) {
        if (attempt === 0 && error instanceof BssSsoError && error.retryable) {
          const delayMs =
            LOGOUT_RETRY_DELAY_MIN_MS +
            Math.floor(Math.random() * (LOGOUT_RETRY_DELAY_JITTER_MS + 1));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  private async post(path: string, payload: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.siteUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new BssSsoError(true);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new BssSsoError(response.status >= 500);
    }
    try {
      return await readBoundedJson(response);
    } catch {
      throw new BssSsoError();
    }
  }
}
