// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AltDetectionPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const SETTINGS = {
  weight_shared_ip: 40,
  weight_shared_name: 20,
  weight_young_account: 15,
  weight_steamid_proximity: 10,
  steamid_delta_threshold: 5000,
  medium_threshold: 40,
  high_threshold: 70,
  updated_at: null,
  updated_by_player_id: null,
};

const IGNORED_IP = {
  id: 'ip-1',
  cidr: '10.0.0.0/24',
  note: 'офис',
  created_by: null,
  author_name: 'Админ',
  created_at: '2026-07-20T10:00:00.000Z',
};

function mockFetch(opts: { status?: number } = {}) {
  const status = opts.status ?? 200;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.includes('/ignored-ips/') && init?.method === 'DELETE') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/settings/alt-detection')) {
      if (status !== 200) return Promise.resolve(new Response(null, { status }));
      return Promise.resolve(
        new Response(JSON.stringify({ settings: SETTINGS, ignored_ips: [IGNORED_IP] }), {
          status: 200,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AltDetectionPage', () => {
  it('is a valid React component', () => {
    expect(AltDetectionPage).toBeDefined();
    expect(typeof AltDetectionPage).toBe('function');
  });

  it(
    'renders the ignored networks and the scoring weights',
    async () => {
      const { fn } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<AltDetectionPage />);
      expect(await screen.findByRole('heading', { name: 'Детектор альтов' })).toBeInTheDocument();
      expect(await screen.findByText('10.0.0.0/24')).toBeInTheDocument();
      expect(screen.getByLabelText('Вес: общий IP')).toHaveValue(40);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'deletes an ignored network only after the confirmation dialog is confirmed',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<AltDetectionPage />);
      await screen.findByText('10.0.0.0/24');

      fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));

      const dialog = await screen.findByRole('dialog', { name: 'Удалить исключение' });
      expect(dialog).toHaveTextContent('10.0.0.0/24');
      expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить исключение' }));

      await waitFor(() => {
        expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true);
      });
      expect(await screen.findByText('Исключение удалено.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'explains the missing permission instead of the settings form on 403',
    async () => {
      const { fn } = mockFetch({ status: 403 });
      vi.stubGlobal('fetch', fn);
      render(<AltDetectionPage />);
      expect(await screen.findByText('Недостаточно прав')).toBeInTheDocument();
      expect(screen.queryByLabelText('Вес: общий IP')).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
