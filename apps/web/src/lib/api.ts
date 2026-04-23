const API_URL = process.env.API_URL ?? 'http://api:3000';

export interface RequestOptions extends RequestInit {
  cookie?: string;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('accept', 'application/json');
  if (opts.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(`${API_URL}${path}`, {
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
