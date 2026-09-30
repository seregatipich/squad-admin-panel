import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { ApiError, apiFetch } from './api';
import { isArrayOf, isRecord } from './json-guards';

export const SESSION_COOKIE = '__Host-sid';

export interface Me {
  player_id: string;
  steam_id64: string | null;
  canonical_name: string;
  avatar_url: string | null;
  permissions: string[];
  squad_permissions: string[];
  /** ECON-5 (#165): economy module flag; gates economy-only nav items. */
  economy_enabled?: boolean;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Checks the `GET /api/v1/me` body: the layout and pages dereference
 * `permissions` at once, so a drifted or proxy-substituted body must fail here
 * as an {@link ApiResponseError} instead of a `TypeError` mid-render.
 *
 * @param body Decoded JSON response.
 * @returns The body, typed as {@link Me}.
 * @throws {TypeError} A field the panel relies on is missing or has the wrong type.
 */
export function parseMe(body: unknown): Me {
  if (!isRecord(body)) throw new TypeError('body must be an object');
  if (typeof body.player_id !== 'string') throw new TypeError('player_id must be a string');
  if (!isArrayOf(body.permissions, isString)) {
    throw new TypeError('permissions must be an array of strings');
  }
  return body as unknown as Me;
}

/**
 * Current operator, resolved through `GET /api/v1/me` once per render.
 *
 * Returns `null` only when there is no session: no cookie, or the API rejects
 * it with 401/403. Any other failure (5xx, network error, timeout) is thrown so
 * the route's error boundary shows an outage instead of a fake logout.
 *
 * @throws {ApiError} The API failed with a status other than 401/403.
 * @throws {Error} The request failed or timed out before a response arrived.
 */
export const getSession = cache(async (): Promise<Me | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await apiFetch<Me>('/api/v1/me', {
      cookie: `${SESSION_COOKIE}=${token}`,
      parse: parseMe,
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
});

/**
 * Like {@link getSession}, but redirects to `/login` when there is no session.
 *
 * @throws Whatever {@link getSession} throws on an API outage.
 */
export async function requireSession(): Promise<Me> {
  const me = await getSession();
  if (!me) redirect('/login');
  return me;
}
