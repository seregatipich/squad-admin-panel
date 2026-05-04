import { describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => {
  class MockNextResponse {
    static redirect(url: URL) {
      return { type: 'redirect', url: url.toString() };
    }
    static next() {
      return { type: 'next' };
    }
  }
  return { NextResponse: MockNextResponse };
});

import { config, middleware } from './middleware';

function makeRequest(pathname: string, hasCookie: boolean) {
  return {
    cookies: { has: (name: string) => (name === '__Host-sid' ? hasCookie : false) },
    nextUrl: {
      pathname,
      clone: () => {
        const url = new URL(`http://localhost${pathname}`);
        return url;
      },
    },
  } as never;
}

describe('middleware', () => {
  it('redirects unauthenticated requests to protected paths', () => {
    const res = middleware(makeRequest('/dashboard', false));
    expect(res.type).toBe('redirect');
    expect(res.url).toContain('/login');
  });

  it('passes through authenticated requests', () => {
    const res = middleware(makeRequest('/dashboard', true));
    expect(res.type).toBe('next');
  });

  it('passes through requests to unprotected paths', () => {
    const res = middleware(makeRequest('/login', false));
    expect(res.type).toBe('next');
  });

  it('redirects /servers without cookie', () => {
    const res = middleware(makeRequest('/servers/abc', false));
    expect(res.type).toBe('redirect');
  });

  it('exports config with matcher array', () => {
    expect(config.matcher).toBeDefined();
    expect(Array.isArray(config.matcher)).toBe(true);
    expect(config.matcher.length).toBeGreaterThan(0);
  });
});
