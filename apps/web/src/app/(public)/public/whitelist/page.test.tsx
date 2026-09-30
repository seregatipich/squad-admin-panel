// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicWhitelistPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const STEAM_ID = '76561198000000001';

function mockFetch(opts: { enabled?: boolean; postStatus?: number; signedIn?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const postStatus = opts.postStatus ?? 201;
  const signedIn = opts.signedIn ?? true;
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/public/whitelist/settings')) {
      return Promise.resolve(new Response(JSON.stringify({ enabled }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(
        signedIn
          ? new Response(JSON.stringify({ steam_id64: STEAM_ID }), { status: 200 })
          : new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
      );
    }
    if (url.endsWith('/api/v1/public/whitelist/applications') && init?.method === 'POST') {
      const bodyText =
        postStatus === 201
          ? JSON.stringify({ id: 'app-1', status: 'pending' })
          : JSON.stringify({ error: 'boom' });
      return Promise.resolve(new Response(bodyText, { status: postStatus }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

async function fillAndSubmit(message: string) {
  fireEvent.change(await screen.findByPlaceholderText(/расскажите о себе/i), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole('button', { name: /отправить заявку/i }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicWhitelistPage', () => {
  it(
    'shows the signed-in SteamID64 read-only next to the application form',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true }));
      render(<PublicWhitelistPage />);
      const steam = await screen.findByDisplayValue(STEAM_ID);
      expect(steam).toHaveAttribute('readonly');
      expect(screen.getByRole('button', { name: /отправить заявку/i })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'asks for a Steam login instead of a typed SteamID64 when signed out (#375)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, signedIn: false }));
      render(<PublicWhitelistPage />);
      const login = await screen.findByRole('link', { name: 'Войти через Steam' });
      expect(login).toHaveAttribute('href', '/api/v1/auth/steam/login');
      expect(screen.queryByRole('button', { name: /отправить заявку/i })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the closed state when the portal is disabled',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: false }));
      render(<PublicWhitelistPage />);
      expect(await screen.findByText(/приём заявок сейчас закрыт/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /отправить заявку/i })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'posts only the message and contact — the SteamID64 comes from the session',
    async () => {
      const fetchMock = mockFetch({ enabled: true, postStatus: 201 });
      vi.stubGlobal('fetch', fetchMock);
      render(<PublicWhitelistPage />);
      await fillAndSubmit('веду сервер');

      await waitFor(() => expect(screen.getByText(/заявка отправлена/i)).toBeInTheDocument());
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ body: 'веду сервер' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the duplicate message on a 409',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, postStatus: 409 }));
      render(<PublicWhitelistPage />);
      await fillAndSubmit('дубликат');
      await waitFor(() => expect(screen.getByText(/уже на рассмотрении/i)).toBeInTheDocument());
      // Someone else may have filed for this SteamID64: point the owner at the
      // Steam login, whose application is verified and is never blocked (#52).
      expect(screen.getByText(/войдите через Steam/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'explains a 403 when the SteamID64 differs from the signed-in Steam account (#52)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, postStatus: 403 }));
      render(<PublicWhitelistPage />);

      fireEvent.change(await screen.findByPlaceholderText('76561198000000000'), {
        target: { value: '76561198000000001' },
      });
      fireEvent.change(screen.getByPlaceholderText(/расскажите о себе/i), {
        target: { value: 'чужой id' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить заявку/i }));

      await waitFor(() =>
        expect(screen.getByText(/не совпадает с аккаунтом Steam/i)).toBeInTheDocument(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers a Steam login that verifies ownership of the SteamID64 (#52)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true }));
      render(<PublicWhitelistPage />);
      const link = await screen.findByRole('link', { name: /войти через steam/i });
      expect(link).toHaveAttribute('href', '/api/v1/auth/steam/login');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the throttling message on a 429',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, postStatus: 429 }));
      render(<PublicWhitelistPage />);

      fireEvent.change(await screen.findByPlaceholderText('76561198000000000'), {
        target: { value: '76561198000000001' },
      });
      fireEvent.change(screen.getByPlaceholderText(/расскажите о себе/i), {
        target: { value: 'частые заявки' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить заявку/i }));

      await waitFor(() => expect(screen.getByText(/слишком много заявок/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an error banner on a 500',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, postStatus: 500 }));
      render(<PublicWhitelistPage />);
      await fillAndSubmit('ошибка');
      await waitFor(() =>
        expect(screen.getByText(/не удалось отправить заявку/i)).toBeInTheDocument(),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
