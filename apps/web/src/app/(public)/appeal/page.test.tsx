// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicAppealPage from './page';

const TEST_TIMEOUT_MS = 15_000;
const STEAM_ID = '76561198000000001';

interface MockOptions {
  /** `/api/v1/me` status; 200 means the visitor is signed in through Steam. */
  meStatus?: number;
  postStatus?: number;
  token?: string;
}

function mockFetch(opts: MockOptions = {}) {
  const meStatus = opts.meStatus ?? 200;
  const postStatus = opts.postStatus ?? 201;
  const token = opts.token ?? 'tracking-token-abcdef123456';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/v1/me') {
      const body =
        meStatus === 200
          ? JSON.stringify({ steam_id64: STEAM_ID, canonical_name: 'Апеллянт' })
          : JSON.stringify({ error: 'unauthenticated' });
      return Promise.resolve(new Response(body, { status: meStatus }));
    }
    if (url.endsWith('/api/v1/public/appeals') && init?.method === 'POST') {
      const body =
        postStatus === 201
          ? JSON.stringify({ id: 'appeal-1', number: 12, status: 'pending', tracking_token: token })
          : JSON.stringify({ error: 'x' });
      return Promise.resolve(new Response(body, { status: postStatus }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fn, calls };
}

async function renderSignedIn(opts: MockOptions = {}) {
  const mock = mockFetch(opts);
  vi.stubGlobal('fetch', mock.fn);
  render(<PublicAppealPage />);
  await screen.findByDisplayValue(STEAM_ID);
  return mock;
}

function fillBody(body: string) {
  fireEvent.change(screen.getByPlaceholderText(/опишите, почему/i), { target: { value: body } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicAppealPage', () => {
  // Regression (#40, #234): the form accepted any SteamID64 anonymously.
  it(
    'asks an anonymous visitor to sign in through Steam instead of showing the form',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ meStatus: 401 }).fn);
      render(<PublicAppealPage />);

      const link = await screen.findByRole('link', { name: 'Войти через Steam' });
      expect(link).toHaveAttribute('href', '/api/v1/auth/steam/login?return_to=%2Fappeal');
      expect(screen.queryByRole('button', { name: /отправить апелляцию/i })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the signed-in SteamID64 read-only',
    async () => {
      await renderSignedIn();
      const field = screen.getByDisplayValue(STEAM_ID);
      expect(field).toHaveAttribute('readonly');
      expect(screen.getByText('Апеллянт')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks submit when the body is too short',
    async () => {
      const { calls } = await renderSignedIn();
      fillBody('разбань');
      submit();

      expect(await screen.findByText(/не менее 20 символов/i)).toBeInTheDocument();
      expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'submits for the signed-in account with the optional contact and shows the tracking link',
    async () => {
      const { calls } = await renderSignedIn({ token: 'my-tracking-token-1234' });
      fillBody('Меня забанили по ошибке, прошу пересмотреть решение.');
      fireEvent.change(screen.getByPlaceholderText(/discord/i), {
        target: { value: 'discord: me#1' },
      });
      submit();

      await waitFor(() =>
        expect(screen.getByText(/\/appeal\/my-tracking-token-1234/)).toBeInTheDocument(),
      );
      expect(screen.getByText(/сохраните эту ссылку/i)).toBeInTheDocument();
      const post = calls.find((c) => c.init?.method === 'POST');
      expect(post?.init?.credentials).toBe('include');
      const payload = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
      expect(payload.steam_id64).toBe(STEAM_ID);
      expect(payload.contact).toBe('discord: me#1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the duplicate message on a 409',
    async () => {
      await renderSignedIn({ postStatus: 409 });
      fillBody('Меня забанили по ошибке, прошу пересмотреть решение.');
      submit();
      await waitFor(() => expect(screen.getByText(/уже на рассмотрении/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the throttling message on a 429',
    async () => {
      await renderSignedIn({ postStatus: 429 });
      fillBody('Меня забанили по ошибке, прошу пересмотреть решение.');
      submit();
      await waitFor(() => expect(screen.getByText(/слишком много заявок/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'falls back to the Steam sign-in when the session expired before submitting',
    async () => {
      await renderSignedIn({ postStatus: 401 });
      fillBody('Меня забанили по ошибке, прошу пересмотреть решение.');
      submit();
      expect(await screen.findByRole('link', { name: 'Войти через Steam' })).toBeInTheDocument();
      expect(screen.getByText(/вход через steam истёк/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a network error banner when the request throws',
    async () => {
      const { fn } = mockFetch();
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
          init?.method === 'POST' ? Promise.reject(new Error('offline')) : fn(input, init),
        ),
      );
      render(<PublicAppealPage />);
      await screen.findByDisplayValue(STEAM_ID);
      fillBody('Меня забанили по ошибке, прошу пересмотреть решение.');
      submit();
      await waitFor(() => expect(screen.getByText(/ошибка сети/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );
});
