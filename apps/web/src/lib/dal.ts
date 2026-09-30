import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { ApiError, apiFetch } from './api';

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
