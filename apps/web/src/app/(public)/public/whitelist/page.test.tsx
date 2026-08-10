// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicWhitelistPage from './page';

const TEST_TIMEOUT_MS = 15_000;

function mockFetch(opts: { enabled?: boolean; postStatus?: number } = {}) {
  const enabled = opts.enabled ?? true;
  const postStatus = opts.postStatus ?? 201;
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/public/whitelist/settings')) {
      return Promise.resolve(new Response(JSON.stringify({ enabled }), { status: 200 }));
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicWhitelistPage', () => {
  it(
    'renders the application form when the portal is open',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true }));
      render(<PublicWhitelistPage />);
      expect(await screen.findByPlaceholderText('76561198000000000')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /отправить заявку/i })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the closed state when the portal is disabled',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: false }));
      render(<PublicWhitelistPage />);
      expect(await screen.findByText(/приём заявок сейчас закрыт/i)).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('76561198000000000')).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks submit and shows a validation error for a non-17-digit SteamID',
    async () => {
      const fetchMock = mockFetch({ enabled: true });
      vi.stubGlobal('fetch', fetchMock);
      render(<PublicWhitelistPage />);

      const steam = await screen.findByPlaceholderText('76561198000000000');
      fireEvent.change(steam, { target: { value: '123' } });
      fireEvent.change(screen.getByPlaceholderText(/расскажите о себе/i), {
        target: { value: 'let me in' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить заявку/i }));

      expect(await screen.findByText(/корректный SteamID64/i)).toBeInTheDocument();
      // No POST fired — only the settings GET happened.
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a success message after a 201',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, postStatus: 201 }));
      render(<PublicWhitelistPage />);

      fireEvent.change(await screen.findByPlaceholderText('76561198000000000'), {
        target: { value: '76561198000000001' },
      });
      fireEvent.change(screen.getByPlaceholderText(/расскажите о себе/i), {
        target: { value: 'веду сервер' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить заявку/i }));

      await waitFor(() => expect(screen.getByText(/заявка отправлена/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the duplicate message on a 409',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, postStatus: 409 }));
      render(<PublicWhitelistPage />);

      fireEvent.change(await screen.findByPlaceholderText('76561198000000000'), {
        target: { value: '76561198000000001' },
      });
      fireEvent.change(screen.getByPlaceholderText(/расскажите о себе/i), {
        target: { value: 'дубликат' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить заявку/i }));

      await waitFor(() => expect(screen.getByText(/уже на рассмотрении/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an error banner on a 500',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ enabled: true, postStatus: 500 }));
      render(<PublicWhitelistPage />);

      fireEvent.change(await screen.findByPlaceholderText('76561198000000000'), {
        target: { value: '76561198000000001' },
      });
      fireEvent.change(screen.getByPlaceholderText(/расскажите о себе/i), {
        target: { value: 'ошибка' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить заявку/i }));

      await waitFor(() =>
        expect(screen.getByText(/не удалось отправить заявку/i)).toBeInTheDocument(),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
