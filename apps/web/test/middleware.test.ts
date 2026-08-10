import { describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => {
  const redirect = vi.fn((url: { toString(): string }) => ({
    status: 307,
    headers: { get: (k: string) => (k === 'location' ? url.toString() : null) },
  }));
  const next = vi.fn(() => ({ status: 200 }));
  return { NextResponse: { redirect, next } };
});

import { config, middleware } from '../src/middleware';

function makeRequest(pathname: string, hasCookie: boolean) {
  const _searchParams = new URLSearchParams();
  return {
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

describe('config.matcher', () => {
  it('includes /dashboard/:path*', () => {
    expect(config.matcher).toContain('/dashboard/:path*');
  });

  it('includes /servers/:path*', () => {
    expect(config.matcher).toContain('/servers/:path*');
  });

  it('includes /settings/:path*', () => {
    expect(config.matcher).toContain('/settings/:path*');
  });

  it('includes /all-players/:path*', () => {
    expect(config.matcher).toContain('/all-players/:path*');
  });

  it('includes /audit/:path*', () => {
    expect(config.matcher).toContain('/audit/:path*');
  });
});
