import { createHash, randomBytes } from 'node:crypto';
import { isPermissionKey, type PermissionKey } from '@squad/shared-config';
import { v7 as uuidv7 } from 'uuid';

export const API_TOKEN_PREFIX = 'sqp_';
export const API_TOKEN_TOUCH_THROTTLE_SECONDS = 60;

export interface MintedApiToken {
  id: string;
  plaintext: string;
  tokenHash: string;
}

export function mintApiToken(): MintedApiToken {
  const id = uuidv7();
  const random = randomBytes(24).toString('base64url');
  const plaintext = `${API_TOKEN_PREFIX}${id}_${random}`;
  return { id, plaintext, tokenHash: hashApiToken(plaintext) };
}

export function hashApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('base64url');
}

export function looksLikeApiToken(value: string): boolean {
  if (!value.startsWith(API_TOKEN_PREFIX)) return false;
  const rest = value.slice(API_TOKEN_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep === -1) return false;
  const uuid = rest.slice(0, sep);
  const random = rest.slice(sep + 1);
  return /^[0-9a-f-]{36}$/i.test(uuid) && random.length >= 16;
}

export interface ScopeValidationResult {
  ok: boolean;
  unknown: string[];
  notGranted: string[];
}

export function validateScopesSubset(
  requested: readonly string[],
  granted: ReadonlySet<PermissionKey>,
): ScopeValidationResult {
  const unknown: string[] = [];
  const notGranted: string[] = [];
  for (const scope of requested) {
    if (!isPermissionKey(scope)) {
      unknown.push(scope);
      continue;
    }
    if (!granted.has(scope)) notGranted.push(scope);
  }
  return { ok: unknown.length === 0 && notGranted.length === 0, unknown, notGranted };
}

export function intersectScopes(
  scopes: readonly string[],
  granted: ReadonlySet<PermissionKey>,
): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const scope of scopes) {
    if (isPermissionKey(scope) && granted.has(scope)) out.add(scope);
  }
  return out;
}

export function extractBearerToken(headerValue: string | string[] | undefined): string | null {
  if (!headerValue) return null;
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return null;
  const match = value.match(/^Bearer\s+(\S+)$/i);
  return match ? (match[1] ?? null) : null;
}
