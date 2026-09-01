// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logout, logoutEverywhere } from './LogoutButton';

let hrefSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hrefSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      set href(value: string) {
        hrefSpy(value);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LogoutButton', () => {
  it('exports a React component function', async () => {
    const mod = await import('./LogoutButton');
    expect(typeof mod.LogoutButton).toBe('function');
  });

  it('keeps local logout separate from global logout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await logout();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/logout');
    expect(hrefSpy).toHaveBeenCalledWith('/login');
  });

  it('navigates global logout to the trusted destination returned by the API', async () => {
    const destination =
      'https://bss.games/cabinet?message=%D0%9F%D0%BE%D0%B2%D1%82%D0%BE%D1%80%D0%B8%D1%82%D0%B5&error=true';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, remote_ok: false, site_url: destination }));
    vi.stubGlobal('fetch', fetchMock);

    await logoutEverywhere();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/logout-all');
    expect(hrefSpy).toHaveBeenCalledWith(destination);
  });

  it('falls back to login when the global response is unavailable or malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ site_url: 'javascript:x' })));

    await logoutEverywhere();

    expect(hrefSpy).toHaveBeenCalledWith('/login');
  });
});
