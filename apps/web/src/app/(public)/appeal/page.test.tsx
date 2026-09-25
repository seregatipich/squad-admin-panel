// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicAppealPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const STEAM_PLACEHOLDER = '76561198000000000';

function mockFetch(opts: { postStatus?: number; token?: string } = {}) {
  const postStatus = opts.postStatus ?? 201;
  const token = opts.token ?? 'tracking-token-abcdef123456';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/v1/public/appeals') && init?.method === 'POST') {
      const body =
        postStatus === 201
          ? JSON.stringify({
              id: 'appeal-1',
              number: 12,
              status: 'pending',
              tracking_token: token,
            })
          : JSON.stringify({ error: postStatus === 429 ? 'rate_limited' : 'appeal_already_open' });
      return Promise.resolve(new Response(body, { status: postStatus }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fn, calls };
}

function fillForm(steam: string, body: string) {
  fireEvent.change(screen.getByPlaceholderText(STEAM_PLACEHOLDER), { target: { value: steam } });
  fireEvent.change(screen.getByPlaceholderText(/опишите, почему/i), { target: { value: body } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicAppealPage', () => {
  it(
    'renders the appeal form without any session',
    () => {
      vi.stubGlobal('fetch', mockFetch().fn);
      render(<PublicAppealPage />);
      expect(screen.getByPlaceholderText(STEAM_PLACEHOLDER)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /отправить апелляцию/i })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks submit and shows a validation error for a non-17-digit SteamID',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<PublicAppealPage />);

      fillForm('123', 'Меня забанили по ошибке, прошу пересмотреть решение.');
      fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));

      expect(await screen.findByText(/корректный SteamID64/i)).toBeInTheDocument();
      expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks submit when the body is too short',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<PublicAppealPage />);

      fillForm('76561198000000001', 'разбань');
      fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));

      expect(await screen.findByText(/не менее 20 символов/i)).toBeInTheDocument();
      expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the tracking link after a successful submission',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ token: 'my-tracking-token-1234' }).fn);
      render(<PublicAppealPage />);

      fillForm('76561198000000001', 'Меня забанили по ошибке, прошу пересмотреть решение.');
      fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));

      await waitFor(() =>
        expect(screen.getByText(/\/appeal\/my-tracking-token-1234/)).toBeInTheDocument(),
      );
      expect(screen.getByText(/сохраните эту ссылку/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends the optional contact field when it is filled in',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<PublicAppealPage />);

      fillForm('76561198000000001', 'Меня забанили по ошибке, прошу пересмотреть решение.');
      fireEvent.change(screen.getByPlaceholderText(/discord/i), {
        target: { value: 'discord: me#1' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));

      await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
      const payload = JSON.parse(
        String(calls.find((c) => c.init?.method === 'POST')?.init?.body),
      ) as Record<string, unknown>;
      expect(payload.steam_id64).toBe('76561198000000001');
      expect(payload.contact).toBe('discord: me#1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the duplicate message on a 409',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ postStatus: 409 }).fn);
      render(<PublicAppealPage />);

      fillForm('76561198000000001', 'Меня забанили по ошибке, прошу пересмотреть решение.');
      fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));

      await waitFor(() => expect(screen.getByText(/уже на рассмотрении/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the throttling message on a 429',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ postStatus: 429 }).fn);
      render(<PublicAppealPage />);

      fillForm('76561198000000001', 'Меня забанили по ошибке, прошу пересмотреть решение.');
      fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));

      await waitFor(() => expect(screen.getByText(/слишком много заявок/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a network error banner when the request throws',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('offline'))),
      );
      render(<PublicAppealPage />);

      fillForm('76561198000000001', 'Меня забанили по ошибке, прошу пересмотреть решение.');
      fireEvent.click(screen.getByRole('button', { name: /отправить апелляцию/i }));

      await waitFor(() => expect(screen.getByText(/ошибка сети/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );
});
