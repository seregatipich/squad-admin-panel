// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from './page';

beforeEach(() => {
  // /api/v1/me returns 401 so the page stays on the login screen.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 }))),
  );
  window.history.replaceState({}, '', '/login');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('renders the sign-in call to action in Russian', async () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: 'Squad Admin Panel' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Войти через Steam' })).toBeInTheDocument();
    expect(screen.queryByText(/единственный способ входа/i)).not.toBeInTheDocument();
  });

  it('localizes the auth_failed error banner', async () => {
    window.history.replaceState({}, '', '/login?error=auth_failed');
    render(<LoginPage />);
    await waitFor(() =>
      expect(
        screen.getByText('Не удалось проверить вход через Steam. Попробуйте ещё раз.'),
      ).toBeInTheDocument(),
    );
  });

  it('interpolates the Steam ID into the not_authorized error', async () => {
    window.history.replaceState({}, '', '/login?error=not_authorized&steam_id64=76561198000000001');
    render(<LoginPage />);
    await waitFor(() =>
      expect(
        screen.getByText(
          'Steam ID 76561198000000001 не имеет доступа к панели. Обратитесь к администратору.',
        ),
      ).toBeInTheDocument(),
    );
  });

  it('does not render a language selector', () => {
    render(<LoginPage />);
    // LocaleSwitch (removed) rendered a <fieldset> — an implicit role="group" —
    // as its outer element, and nothing else on this page uses that role, so
    // its absence is a reliable guard against the selector coming back.
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});
