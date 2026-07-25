// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WhitelistSettingsPage from './page';

const TEST_TIMEOUT_MS = 15_000;

function mockFetch(opts: { permissions?: string[] } = {}) {
  const permissions = opts.permissions ?? ['whitelist:view', 'whitelist:edit'];
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/whitelist/applications/settings')) {
      return Promise.resolve(
        new Response(JSON.stringify({ enabled: false, default_days: null }), { status: 200 }),
      );
    }
    if (url.includes('/api/v1/whitelist/applications')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], total: 0, page: 1, page_size: 20 }), {
          status: 200,
        }),
      );
    }
    if (url.endsWith('/api/v1/whitelist/settings')) {
      return Promise.resolve(
        new Response(JSON.stringify({ whitelist_role_id: null, whitelist_role_name: null }), {
          status: 200,
        }),
      );
    }
    if (url.endsWith('/api/v1/roles')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WhitelistSettingsPage', () => {
  it(
    'renders the whitelist role section and the applications section',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<WhitelistSettingsPage />);
      expect(await screen.findByRole('heading', { name: 'Whitelist' })).toBeInTheDocument();
      expect(await screen.findByText(/заявки на whitelist/i)).toBeInTheDocument();
      expect(screen.getByText(/приём заявок открыт/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the portal save control when the user lacks whitelist:edit',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ permissions: ['whitelist:view'] }));
      render(<WhitelistSettingsPage />);
      await screen.findByText(/заявки на whitelist/i);
      expect(screen.queryByRole('button', { name: /сохранить настройки портала/i })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
