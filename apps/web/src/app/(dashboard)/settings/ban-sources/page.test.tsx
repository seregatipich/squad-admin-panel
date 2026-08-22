// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/ban-sources'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import BanSourcesPage from './page';

/**
 * jsdom знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а подтверждение «Удалить источник банов» построено на примитиве `AlertDialog`.
 * Полифилл повторяет ровно то, на что опирается примитив: атрибут `open`,
 * фокус внутрь окна и цепочку Escape → отменяемое `cancel` → `close`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const notPrevented = this.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (notPrevented) this.close();
    };
    escapeHandlers.set(this, onKeyDown);
    this.addEventListener('keydown', onKeyDown);
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const onKeyDown = escapeHandlers.get(this);
    if (onKeyDown) {
      this.removeEventListener('keydown', onKeyDown);
      escapeHandlers.delete(this);
    }
    this.dispatchEvent(new Event('close'));
  };
}

const TEST_TIMEOUT_MS = 15_000;

const SOURCE = {
  id: 'src-1',
  name: 'Ру-Баны',
  url: 'https://example.com/bans.cfg',
  format: 'squad_bans_cfg',
  trust_level: 'trusted',
  on_match: 'kick',
  discord_url: null,
  enabled: true,
  poll_interval_minutes: 60,
  last_sync_at: null,
  last_sync_status: null,
  last_sync_error: null,
  imported_count: 0,
  record_count: 12,
  has_auth_header: false,
  created_at: '2026-07-20T10:00:00.000Z',
};

const PUBLICATION = {
  enabled: false,
  publish_scope: 'all_active' as const,
  updated_at: null,
};

function mockFetch(opts: { canManage?: boolean } = {}) {
  const canManage = opts.canManage ?? true;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.includes('/api/v1/ban-sources/') && init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.endsWith('/api/v1/ban-sources')) {
      return Promise.resolve(new Response(JSON.stringify([SOURCE]), { status: 200 }));
    }
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(
        new Response(JSON.stringify({ permissions: [], can_manage_ban_sources: canManage }), {
          status: 200,
        }),
      );
    }
    if (url.endsWith('/api/v1/settings/banlist-publication')) {
      return Promise.resolve(new Response(JSON.stringify(PUBLICATION), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BanSourcesPage', () => {
  it('is a valid React component', () => {
    expect(BanSourcesPage).toBeDefined();
    expect(typeof BanSourcesPage).toBe('function');
  });

  it(
    'renders the loaded source with its trust level and record count',
    async () => {
      const { fn } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<BanSourcesPage />);
      expect(await screen.findByRole('heading', { name: 'Ру-Баны' })).toBeInTheDocument();
      expect(screen.getByText('Доверие: Доверенный')).toBeInTheDocument();
      expect(screen.getByText('12')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'deletes a source only after the exact name is retyped in the dialog',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<BanSourcesPage />);
      await screen.findByRole('heading', { name: 'Ру-Баны' });

      fireEvent.click(screen.getByRole('button', { name: 'Удалить источник Ру-Баны' }));

      const dialog = await screen.findByRole('dialog', { name: 'Удалить источник банов' });
      const confirm = within(dialog).getByRole('button', { name: 'Удалить источник' });
      expect(confirm).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText('Повторите имя источника'), {
        target: { value: 'Ру-Баны' },
      });
      expect(confirm).toBeEnabled();
      expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);

      fireEvent.click(confirm);
      await waitFor(() => {
        expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides mutating controls without the ban-sources permission',
    async () => {
      const { fn } = mockFetch({ canManage: false });
      vi.stubGlobal('fetch', fn);
      render(<BanSourcesPage />);
      await screen.findByRole('heading', { name: 'Ру-Баны' });
      expect(screen.queryByRole('button', { name: 'Удалить источник Ру-Баны' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Синхронизировать' })).toBeNull();
      expect(screen.getByText('Только просмотр')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
