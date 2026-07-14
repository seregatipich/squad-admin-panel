// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicationSection } from './PublicationSection';

const TEST_TIMEOUT_MS = 15_000;

const SETTINGS = {
  enabled: true,
  publish_scope: 'all_active' as const,
  updated_at: '2026-01-01T00:00:00.000Z',
};

function mockFetch(opts: { getStatus?: number; putStatus?: number } = {}) {
  const getStatus = opts.getStatus ?? 200;
  const putStatus = opts.putStatus ?? 200;
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.endsWith('/api/v1/settings/banlist-publication')) {
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }
    if (init?.method === 'PUT') {
      if (putStatus !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'forbidden' }), { status: putStatus }),
        );
      }
      const body = JSON.parse(String(init.body)) as { enabled: boolean; publish_scope: string };
      return Promise.resolve(
        new Response(
          JSON.stringify({ ...SETTINGS, ...body, updated_at: '2026-02-02T00:00:00.000Z' }),
          { status: 200 },
        ),
      );
    }
    if (getStatus !== 200) {
      return Promise.resolve(new Response(null, { status: getStatus }));
    }
    return Promise.resolve(new Response(JSON.stringify(SETTINGS), { status: 200 }));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicationSection', () => {
  it(
    'renders the master switch and scope radios from the loaded settings',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<PublicationSection />);

      const toggle = await screen.findByLabelText('Публиковать банлист наружу');
      expect(toggle).toBeChecked();
      expect(screen.getByLabelText('Все активные баны')).toBeChecked();
      expect(screen.getByLabelText('Только перманентные')).not.toBeChecked();
      expect(screen.getAllByText(/banlist:read/).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'saves the toggled scope via PUT and shows a confirmation',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<PublicationSection />);

      await screen.findByLabelText('Публиковать банлист наружу');
      fireEvent.click(screen.getByLabelText('Только перманентные'));
      fireEvent.click(screen.getByRole('button', { name: /сохранить/i }));

      await waitFor(() =>
        expect(screen.getByText(/настройки публикации банлиста сохранены/i)).toBeInTheDocument(),
      );
      expect(screen.getByLabelText('Только перманентные')).toBeChecked();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the settings fetch is unauthorized (401)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ getStatus: 401 }));
      const { container } = render(<PublicationSection />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the settings fetch is forbidden (403)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ getStatus: 403 }));
      const { container } = render(<PublicationSection />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides on a 403 that only occurs on save (PUT)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ putStatus: 403 }));
      render(<PublicationSection />);

      await screen.findByLabelText('Публиковать банлист наружу');
      fireEvent.click(screen.getByRole('button', { name: /сохранить/i }));

      await waitFor(() => expect(screen.queryByLabelText('Публиковать банлист наружу')).toBeNull());
    },
    TEST_TIMEOUT_MS,
  );
});
