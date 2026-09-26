// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatFlagsPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const RULE = {
  id: 'rule-1',
  pattern: 'мудак',
  pattern_type: 'word',
  locale: 'ru',
  enabled: true,
  created_by: null,
  author_name: 'Админ',
  created_at: '2026-07-20T10:00:00.000Z',
};

function mockFetch(opts: { permissions?: string[] } = {}) {
  const permissions = opts.permissions ?? ['role:edit'];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/settings/chat-flag-rules')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [RULE] }), { status: 200 }));
    }
    if (url.includes('/api/v1/settings/chat-flag-rules/') && init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatFlagsPage', () => {
  it('is a valid React component', () => {
    expect(ChatFlagsPage).toBeDefined();
    expect(typeof ChatFlagsPage).toBe('function');
  });

  it(
    'lists the loaded rules under the page heading',
    async () => {
      const { fn } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ChatFlagsPage />);
      expect(await screen.findByRole('heading', { name: 'Флаги чата' })).toBeInTheDocument();
      expect(await screen.findByText('мудак')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'deletes a rule only after the confirmation dialog is confirmed',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ChatFlagsPage />);
      await screen.findByText('мудак');

      fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));

      const dialog = await screen.findByRole('dialog', { name: 'Удалить правило' });
      expect(dialog).toHaveTextContent('мудак');
      expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить правило' }));

      await waitFor(() => {
        expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true);
      });
      expect(await screen.findByText('Правило удалено.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides mutating controls without role:edit',
    async () => {
      const { fn } = mockFetch({ permissions: [] });
      vi.stubGlobal('fetch', fn);
      render(<ChatFlagsPage />);
      await screen.findByText('мудак');
      expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Переиндексировать' })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
