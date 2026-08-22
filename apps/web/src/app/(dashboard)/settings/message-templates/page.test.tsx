// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageTemplatesPage from './page';

/**
 * jsdom знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а подтверждение «Удалить шаблон» построено на примитиве `AlertDialog`.
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

const TEMPLATE = {
  id: 'tpl-1',
  title: 'Освободить технику',
  body: '{player}, освободите технику на {server}.',
  category: 'warn',
  locale: 'ru',
  sort_order: 3,
  is_enabled: true,
  created_at: '2026-07-20T10:00:00.000Z',
  updated_at: '2026-07-20T10:00:00.000Z',
};

function mockFetch(opts: { permissions?: string[]; templates?: unknown[] } = {}) {
  const permissions = opts.permissions ?? ['role:edit'];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/v1/message-templates')) {
      if (init?.method) return Promise.resolve(new Response('{}', { status: 200 }));
      return Promise.resolve(
        new Response(JSON.stringify(opts.templates ?? [TEMPLATE]), { status: 200 }),
      );
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

describe('MessageTemplatesPage', () => {
  it('is a valid React component', () => {
    expect(MessageTemplatesPage).toBeDefined();
    expect(typeof MessageTemplatesPage).toBe('function');
  });

  it(
    'lists the stored templates in a table',
    async () => {
      mockFetch();
      render(<MessageTemplatesPage />);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Шаблоны сообщений' }),
      ).toBeVisible();
      const table = screen.getByRole('table', { name: 'Шаблоны сообщений' });
      expect(within(table).getByText('Освободить технику')).toBeInTheDocument();
      expect(within(table).getByText('включён')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an empty state instead of an empty table',
    async () => {
      mockFetch({ templates: [] });
      render(<MessageTemplatesPage />);

      expect(await screen.findByText('Шаблонов пока нет')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the editing controls without the role:edit permission',
    async () => {
      mockFetch({ permissions: [] });
      render(<MessageTemplatesPage />);

      await screen.findByRole('table', { name: 'Шаблоны сообщений' });
      expect(screen.queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Название')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the template when the delete confirmation is cancelled',
    async () => {
      const { calls } = mockFetch();
      render(<MessageTemplatesPage />);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Удалить шаблон Освободить технику' }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Удалить шаблон' });
      // «Отмена» носят и крестик окна, и кнопка подвала — нужна вторая.
      const cancels = within(dialog).getAllByRole('button', { name: 'Отмена' });
      fireEvent.click(cancels[cancels.length - 1] as HTMLElement);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(calls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'deletes a template only after the confirmation dialog is confirmed',
    async () => {
      const { calls } = mockFetch();
      render(<MessageTemplatesPage />);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Удалить шаблон Освободить технику' }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Удалить шаблон' });
      expect(dialog).toHaveTextContent('Освободить технику');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить шаблон' }));

      await waitFor(() => {
        const deletes = calls.filter((call) => call.init?.method === 'DELETE');
        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.url).toBe('/api/v1/message-templates/tpl-1');
      });
      expect(await screen.findByText('Шаблон удалён.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'toggles a template through its switch',
    async () => {
      const { calls } = mockFetch();
      render(<MessageTemplatesPage />);

      fireEvent.click(
        await screen.findByRole('switch', { name: 'Включить шаблон Освободить технику' }),
      );

      await waitFor(() => {
        const patches = calls.filter((call) => call.init?.method === 'PATCH');
        expect(patches).toHaveLength(1);
        expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({ is_enabled: false });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to save a template without a title',
    async () => {
      const { calls } = mockFetch();
      render(<MessageTemplatesPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Создать' }));

      expect(await screen.findByText('Укажите название шаблона.')).toBeInTheDocument();
      expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loads a template into the form for editing and can abandon it',
    async () => {
      mockFetch();
      render(<MessageTemplatesPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
      expect(await screen.findByLabelText('Название')).toHaveValue('Освободить технику');
      expect(screen.getByRole('button', { name: 'Сохранить' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
      await waitFor(() => expect(screen.getByLabelText('Название')).toHaveValue(''));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates a template from the form',
    async () => {
      const { calls } = mockFetch();
      render(<MessageTemplatesPage />);

      fireEvent.change(await screen.findByLabelText('Название'), {
        target: { value: 'Новый шаблон' },
      });
      fireEvent.change(screen.getByLabelText(/^Текст/), { target: { value: 'Привет {player}' } });
      fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

      await waitFor(() => {
        const posts = calls.filter((call) => call.init?.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(JSON.parse(String(posts[0]?.init?.body))).toMatchObject({
          title: 'Новый шаблон',
          body: 'Привет {player}',
          category: 'warn',
          locale: 'ru',
        });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a failed load',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
      );
      render(<MessageTemplatesPage />);

      expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
