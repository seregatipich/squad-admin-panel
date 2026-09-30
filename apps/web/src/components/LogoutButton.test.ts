// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logout } from './LogoutButton';

const originalLocation = window.location;

function captureRedirect(): { href: string } {
  const location = { href: '' };
  Object.defineProperty(window, 'location', { value: location, configurable: true });
  return location;
}

afterEach(() => {
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
  vi.unstubAllGlobals();
});

describe('LogoutButton', () => {
  it('exports a React component function', async () => {
    const mod = await import('./LogoutButton');
    expect(typeof mod.LogoutButton).toBe('function');
  });

  it('redirects to the login page after a successful logout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const location = captureRedirect();

    await logout();

    expect(location.href).toBe('/login');
  });

  it('flags the login page when the server failed to revoke the session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
    const location = captureRedirect();

    await logout();

    expect(location.href).toBe('/login?error=logout_failed');
  });

  it('still redirects without rejecting when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const location = captureRedirect();

    await expect(logout()).resolves.toBeUndefined();
    expect(location.href).toBe('/login');
  });
});
