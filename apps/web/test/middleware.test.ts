import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => {
  const redirect = vi.fn((url: { toString(): string }) => ({
    status: 307,
    headers: { get: (k: string) => (k === 'location' ? url.toString() : null) },
  }));
  const next = vi.fn((init?: { request?: { headers?: Headers } }) => ({
    status: 200,
    headers: new Headers(),
    forwardedRequestHeaders: init?.request?.headers,
  }));
  return { NextResponse: { redirect, next } };
});

type PassThrough = { status: number; headers: Headers; forwardedRequestHeaders?: Headers };

import { config, middleware } from '../src/middleware';

function makeRequest(pathname: string, hasCookie: boolean) {
  return {
    headers: new Headers({ accept: 'text/html' }),
    cookies: { has: (name: string) => hasCookie && name === '__Host-sid' },
    nextUrl: {
      pathname,
      clone() {
        let _pathname = pathname;
        const _searchParams = new URLSearchParams();
        return {
          get pathname() {
            return _pathname;
          },
          set pathname(v: string) {
            _pathname = v;
          },
          searchParams: {
            set(k: string, v: string) {
              _searchParams.set(k, v);
            },
          },
          toString() {
            return `http://localhost${_pathname}?${_searchParams.toString()}`;
          },
        };
      },
    },
  } as unknown as import('next/server').NextRequest;
}

describe('middleware', () => {
  it('redirects unauthenticated user from /dashboard to /login', () => {
    const res = middleware(makeRequest('/dashboard', false));
    expect((res as { status: number }).status).toBe(307);
  });

  it('redirects unauthenticated user from /servers/abc with ?next=/servers/abc', () => {
    const res = middleware(makeRequest('/servers/abc', false));
    expect((res as { status: number }).status).toBe(307);
    const location = (res as { headers: { get(k: string): string | null } }).headers.get(
      'location',
    );
    expect(location).toContain('next=%2Fservers%2Fabc');
  });

  it('sets redirect destination to /login', () => {
    const res = middleware(makeRequest('/audit', false));
    const location = (res as { headers: { get(k: string): string | null } }).headers.get(
      'location',
    );
    expect(location).toContain('/login');
  });

  it('passes through authenticated user without redirect', () => {
    const res = middleware(makeRequest('/dashboard', true));
    expect((res as { status: number }).status).toBe(200);
  });

  it('passes through unauthenticated request to public path', () => {
    const res = middleware(makeRequest('/login', false));
    expect((res as { status: number }).status).toBe(200);
  });
});

describe('Content-Security-Policy (#60, finding 424)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends a nonce policy without inline scripts in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = middleware(makeRequest('/dashboard', true)) as unknown as PassThrough;

    const policy = res.headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+';/);
    expect(policy).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  });

  it('forwards the same nonce to the render so Next.js stamps its inline scripts', () => {
    const res = middleware(makeRequest('/login', false)) as unknown as PassThrough;

    const nonce = res.forwardedRequestHeaders?.get('x-nonce');
    expect(nonce).toBeTruthy();
    expect(res.forwardedRequestHeaders?.get('content-security-policy')).toContain(
      `'nonce-${nonce}'`,
    );
    expect(res.headers.get('content-security-policy')).toBe(
      res.forwardedRequestHeaders?.get('content-security-policy'),
    );
    expect(res.forwardedRequestHeaders?.get('accept')).toBe('text/html');
  });

  it('issues a fresh nonce per request', () => {
    const first = middleware(makeRequest('/login', false)) as unknown as PassThrough;
    const second = middleware(makeRequest('/login', false)) as unknown as PassThrough;

    expect(first.forwardedRequestHeaders?.get('x-nonce')).not.toBe(
      second.forwardedRequestHeaders?.get('x-nonce'),
    );
  });

  it('gives the config editor its Monaco directives', () => {
    const res = middleware(makeRequest('/servers/abc/configs', true)) as unknown as PassThrough;

    expect(res.headers.get('content-security-policy')).toContain("worker-src 'self' blob:");
  });
});

describe('config.matcher', () => {
  const [entry] = config.matcher;
  const pattern = new RegExp(`^${entry?.source}$`);

  it('covers every page, including routes outside the session-redirect prefixes', () => {
    for (const path of [
      '/',
      '/login',
      '/dashboard',
      '/matches',
      '/servers/abc/configs',
      '/stats',
    ]) {
      expect(pattern.test(path)).toBe(true);
    }
  });

  it('skips the API, health probes and build assets', () => {
    for (const path of [
      '/api/v1/ws/live',
      '/health',
      '/ready',
      '/_next/static/chunks/main.js',
      '/_next/image',
      '/favicon.ico',
    ]) {
      expect(pattern.test(path)).toBe(false);
    }
  });

  it('skips router prefetches, which render no document', () => {
    expect(entry?.missing).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'next-router-prefetch' })]),
    );
  });
});
