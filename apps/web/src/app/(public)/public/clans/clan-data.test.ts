import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.7' })),
}));

import { formatOnlineHours, getPublicClan, getPublicClans } from './clan-data';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response('{"items":[],"total":0}', { status: 200 })),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function forwardedFor(fn: ReturnType<typeof vi.fn>): string | null {
  const init = fn.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers).get('x-forwarded-for');
}

// #755: SSR fetches must carry the visitor's IP, otherwise every anonymous
// visitor shares the web container's per-IP rate-limit bucket on the API.
describe('public clan fetchers forward the visitor IP', () => {
  it('getPublicClans sends x-forwarded-for from the incoming request', async () => {
    const fn = stubFetch();
    await getPublicClans();
    expect(forwardedFor(fn)).toBe('203.0.113.7');
  });

  it('getPublicClan sends x-forwarded-for from the incoming request', async () => {
    const fn = stubFetch();
    await getPublicClan('clan-1');
    expect(forwardedFor(fn)).toBe('203.0.113.7');
  });
});

describe('formatOnlineHours', () => {
  it('formats aggregate online seconds in Russian hours', () => {
    expect(formatOnlineHours(5400)).toBe('1,5 ч');
  });

  it('does not render negative activity', () => {
    expect(formatOnlineHours(-1)).toBe('0,0 ч');
  });
});
