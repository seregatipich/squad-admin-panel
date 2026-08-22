// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/alerts'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import AlertsPage from './page';

/**
 * jsdom знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а подтверждение «Удалить правило» построено на примитиве `AlertDialog`.
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

const RULE = {
  id: 'rule-1',
  name: 'Падение боевого',
  type: 'server_crashed',
  config: {},
  channels: ['email'],
  enabled: true,
  created_at: '2026-07-20T10:00:00.000Z',
  updated_at: '2026-07-20T10:00:00.000Z',
};

const EVENT = {
  id: 'event-1',
  rule_id: 'rule-1',
  rule_name: 'Падение боевого',
  rule_type: 'server_crashed',
  triggered_at: '2026-07-21T12:00:00.000Z',
  payload: { server: 'ru-1' },
  severity: 'critical',
  delivered: true,
};

function mockFetch(opts: { permissions?: string[]; rules?: unknown[]; events?: unknown[] } = {}): {
  calls: { url: string; init?: RequestInit }[];
  fn: ReturnType<typeof vi.fn>;
} {
  const permissions = opts.permissions ?? ['role:edit'];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/v1/alert-rules')) {
      if (init?.method === 'DELETE' || init?.method === 'PUT' || init?.method === 'POST') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(opts.rules ?? [RULE]), { status: 200 }));
    }
    if (url.startsWith('/api/v1/alerts')) {
      return Promise.resolve(new Response(JSON.stringify(opts.events ?? [EVENT]), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AlertsPage', () => {
  it('is a valid React component', () => {
    expect(AlertsPage).toBeDefined();
    expect(typeof AlertsPage).toBe('function');
  });

  it(
    'lists rules and their trigger history',
    async () => {
      mockFetch();
      render(<AlertsPage />);

      expect(await screen.findByRole('heading', { level: 1, name: 'Оповещения' })).toBeVisible();
      // Имя правила встречается и в списке правил, и в строке истории.
      expect(await screen.findAllByText('Падение боевого')).toHaveLength(2);
      expect(
        screen.getByRole('switch', { name: 'Включить правило Падение боевого' }),
      ).toBeChecked();
      expect(
        screen.getByRole('table', { name: 'История срабатываний правил' }),
      ).toBeInTheDocument();
      expect(screen.getByText('Критично')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an empty state instead of an empty rule list',
    async () => {
      mockFetch({ rules: [], events: [] });
      render(<AlertsPage />);

      expect(await screen.findByText('Правил пока нет')).toBeInTheDocument();
      expect(screen.getByText('Срабатываний пока нет')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides management controls without the role:edit permission',
    async () => {
      mockFetch({ permissions: [] });
      render(<AlertsPage />);

      expect(await screen.findByText('Только просмотр')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Удалить правило Падение боевого' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('switch', { name: 'Включить правило Падение боевого' }),
      ).toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the rule when the delete confirmation is cancelled',
    async () => {
      const { calls } = mockFetch();
      render(<AlertsPage />);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Удалить правило Падение боевого' }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Удалить правило' });
      // «Отмена» носят и крестик окна, и кнопка подвала — нужна вторая.
      const cancels = within(dialog).getAllByRole('button', { name: 'Отмена' });
      fireEvent.click(cancels[cancels.length - 1] as HTMLElement);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(calls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'deletes a rule only after the confirmation dialog is confirmed',
    async () => {
      const { calls } = mockFetch();
      render(<AlertsPage />);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Удалить правило Падение боевого' }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Удалить правило' });
      expect(dialog).toHaveTextContent('Падение боевого');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить правило' }));

      await waitFor(() => {
        const deletes = calls.filter((call) => call.init?.method === 'DELETE');
        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.url).toBe('/api/v1/alert-rules/rule-1');
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'toggles a rule through its switch',
    async () => {
      const { calls } = mockFetch();
      render(<AlertsPage />);

      fireEvent.click(
        await screen.findByRole('switch', { name: 'Включить правило Падение боевого' }),
      );

      await waitFor(() => {
        const puts = calls.filter((call) => call.init?.method === 'PUT');
        expect(puts).toHaveLength(1);
        expect(JSON.parse(String(puts[0]?.init?.body))).toEqual({ enabled: false });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to create a rule without a name',
    async () => {
      const { calls } = mockFetch();
      render(<AlertsPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Добавить правило' }));

      expect(await screen.findByText('Укажите имя правила.')).toBeInTheDocument();
      expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates a rule from the form',
    async () => {
      const { calls } = mockFetch();
      render(<AlertsPage />);

      fireEvent.change(await screen.findByLabelText('Имя'), {
        target: { value: 'Новое правило' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Добавить правило' }));

      await waitFor(() => {
        const posts = calls.filter((call) => call.init?.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(JSON.parse(String(posts[0]?.init?.body))).toMatchObject({
          name: 'Новое правило',
          type: 'server_crashed',
          channels: ['email'],
          enabled: true,
        });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a failed load with a retry action',
    async () => {
      const fn = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));
      vi.stubGlobal('fetch', fn);
      render(<AlertsPage />);

      expect(await screen.findByText('Не удалось загрузить оповещения')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
      await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(3));
    },
    TEST_TIMEOUT_MS,
  );
});
