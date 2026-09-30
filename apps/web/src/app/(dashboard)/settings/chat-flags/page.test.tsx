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

function mockFetch(opts: { canMutate?: boolean; reindexStatus?: number } = {}) {
  const canMutate = opts.canMutate ?? true;
  const reindexStatus = opts.reindexStatus ?? 200;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/api/v1/settings/chat-flag-rules')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [RULE], can_mutate: canMutate }), { status: 200 }),
      );
    }
    if (url.endsWith('/api/v1/settings/chat-flag-rules/reindex') && init?.method === 'POST') {
      const body =
        reindexStatus === 200
          ? { days: 7, scanned: 0, flagged: 0, changed: 0 }
          : { error: 'reindex_in_progress' };
      return Promise.resolve(new Response(JSON.stringify(body), { status: reindexStatus }));
    }
    if (url.includes('/api/v1/settings/chat-flag-rules/') && init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.endsWith('/api/v1/settings/chat-flag-rules/reindex')) {
      return Promise.resolve(
        new Response(JSON.stringify({ scanned: 0, flagged: 0 }), { status: 200 }),
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
    'explains a 409 from reindex as a run already in progress (#345)',
    async () => {
      const { fn } = mockFetch({ reindexStatus: 409 });
      vi.stubGlobal('fetch', fn);
      render(<ChatFlagsPage />);
      await screen.findByText('мудак');
      fireEvent.click(screen.getByRole('button', { name: 'Переиндексировать' }));
      expect(
        await screen.findByText('Переиндексация уже выполняется — дождитесь её завершения.'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides mutating controls when the API reports can_mutate=false',
    async () => {
      const { fn } = mockFetch({ canMutate: false });
      vi.stubGlobal('fetch', fn);
      render(<ChatFlagsPage />);
      await screen.findByText('мудак');
      expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Переиндексировать' })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets the reindex days field stay empty while typing instead of snapping to 1',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ChatFlagsPage />);
      await screen.findByText('мудак');

      const input = screen.getByLabelText('Дней назад') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      expect(input.value).toBe('');
      fireEvent.change(input, { target: { value: '30' } });
      expect(input.value).toBe('30');

      fireEvent.click(screen.getByRole('button', { name: 'Переиндексировать' }));

      await waitFor(() => {
        const reindexCall = calls.find((c) => c.url.endsWith('/reindex'));
        expect(reindexCall).toBeDefined();
        expect(JSON.parse(String(reindexCall?.init?.body))).toEqual({ days: 30 });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'clamps an out-of-range reindex days value on blur',
    async () => {
      const { fn } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ChatFlagsPage />);
      await screen.findByText('мудак');

      const input = screen.getByLabelText('Дней назад') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '9000' } });
      fireEvent.blur(input);
      expect(input.value).toBe('365');

      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      expect(input.value).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );
});
