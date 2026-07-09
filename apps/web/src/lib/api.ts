const API_URL = process.env.API_URL ?? 'http://api:3000';

export interface RequestOptions extends RequestInit {
  cookie?: string;
}

/**
 * Fetches a JSON API endpoint.
 *
 * Server-side (Server Components, route handlers) this targets `API_URL`
 * directly. Client-side (`'use client'` components running in the browser)
 * it issues a same-origin relative request instead: the browser cannot
 * resolve the internal `API_URL` host, but a relative path is forwarded to
 * the API by the Next.js rewrite in `next.config.mjs`.
 */
export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('accept', 'application/json');
  if (opts.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const url = typeof window === 'undefined' ? `${API_URL}${path}` : path;
  const res = await fetch(url, {
    ...opts,
    headers,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
