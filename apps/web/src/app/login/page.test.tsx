// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from './page';

let hrefSpy: ReturnType<typeof vi.fn>;
let currentSearch = '';

beforeEach(() => {
  // /api/v1/me returns 401 so the page stays on the login screen.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 }))),
  );
  hrefSpy = vi.fn();
  currentSearch = '';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get search() {
        return currentSearch;
      },
      set href(value: string) {
        hrefSpy(value);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('automatically begins BSS login once when no local session exists', async () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: 'Squad Admin Panel' })).toBeInTheDocument();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/api/v1/auth/bss/login'));
    expect(hrefSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: /Steam/i })).not.toBeInTheDocument();
  });

  it('does not loop after an SSO error and offers one manual retry', async () => {
    currentSearch = '?error=sso_failed';
    render(<LoginPage />);
    await waitFor(() =>
      expect(
        screen.getByText('Не удалось войти через bss.games. Повторите вход.'),
      ).toBeInTheDocument(),
    );
    expect(hrefSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Повторить вход' })).toHaveAttribute(
      'href',
      '/api/v1/auth/bss/login',
    );
    expect(screen.queryByRole('link', { name: /Steam/i })).not.toBeInTheDocument();
  });

  it('interpolates the Steam ID into the not_authorized error', async () => {
    currentSearch = '?error=not_authorized&steam_id64=76561198000000001';
    render(<LoginPage />);
    await waitFor(() =>
      expect(
        screen.getByText(
          'Steam ID 76561198000000001 не имеет доступа к панели. Обратитесь к администратору.',
        ),
      ).toBeInTheDocument(),
    );
    expect(hrefSpy).not.toHaveBeenCalled();
  });

  it('returns an already authenticated session to the dashboard', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    render(<LoginPage />);

    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/dashboard'));
    expect(hrefSpy).toHaveBeenCalledTimes(1);
  });

  it('does not render a language selector', () => {
    render(<LoginPage />);
    // LocaleSwitch (removed) rendered a <fieldset> — an implicit role="group" —
    // as its outer element, and nothing else on this page uses that role, so
    // its absence is a reliable guard against the selector coming back.
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});
