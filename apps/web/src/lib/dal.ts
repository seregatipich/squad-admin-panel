import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { apiFetch } from './api';

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

export const getSession = cache(async (): Promise<Me | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await apiFetch<Me>('/api/v1/me', {
      cookie: `${SESSION_COOKIE}=${token}`,
    });
  } catch {
    return null;
  }
});

export async function requireSession(): Promise<Me> {
  const me = await getSession();
  if (!me) redirect('/login');
  return me;
}
