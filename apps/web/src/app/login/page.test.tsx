// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

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
    render(
      <LocaleProvider locale="ru">
        <LoginPage />
      </LocaleProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Squad Admin Panel' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Войти через Steam' })).toBeInTheDocument();
    expect(screen.queryByText(/единственный способ входа/i)).not.toBeInTheDocument();
  });

  it('renders the sign-in call to action in English', () => {
    render(
      <LocaleProvider locale="en">
        <LoginPage />
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Sign in with Steam' })).toBeInTheDocument();
    expect(screen.queryByText(/the only way to sign in/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Войти через Steam')).not.toBeInTheDocument();
  });

  it('localizes the auth_failed error banner', async () => {
    window.history.replaceState({}, '', '/login?error=auth_failed');
    render(
      <LocaleProvider locale="en">
        <LoginPage />
      </LocaleProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByText('Could not verify your Steam sign-in. Please try again.'),
      ).toBeInTheDocument(),
    );
  });

  it('interpolates the Steam ID into the not_authorized error', async () => {
    window.history.replaceState({}, '', '/login?error=not_authorized&steam_id64=76561198000000001');
    render(
      <LocaleProvider locale="ru">
        <LoginPage />
      </LocaleProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          'Steam ID 76561198000000001 не имеет доступа к панели. Обратитесь к администратору.',
        ),
      ).toBeInTheDocument(),
    );
  });
});
