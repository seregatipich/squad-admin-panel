// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/automation'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import AutomationPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const RULE = {
  id: 'rule-1',
  server_id: null,
  name: 'Кик за спам',
  condition_type: 'chat_keyword',
  condition: { keyword: 'спам' },
  action_type: 'kick',
  action: { reason: 'спам' },
  enabled: true,
  created_at: '2026-07-20T10:00:00.000Z',
  updated_at: '2026-07-20T10:00:00.000Z',
};

const RUN = {
  id: 'run-1',
  rule_id: 'rule-1',
  rule_name: 'Кик за спам',
  condition_type: 'chat_keyword',
  action_type: 'kick',
  fired_at: '2026-07-21T12:00:00.000Z',
  matched: { keyword: 'спам' },
  action_result: null,
  dry_run: true,
  status: 'executed',
};

function mockFetch(opts: { permissions?: string[]; rules?: unknown[]; runs?: unknown[] } = {}) {
  const permissions = opts.permissions ?? ['role:edit'];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/dry-run')) {
      return Promise.resolve(new Response(JSON.stringify({ matched: true }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/automation-rules')) {
      if (init?.method) return Promise.resolve(new Response('{}', { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(opts.rules ?? [RULE]), { status: 200 }));
    }
    if (url.startsWith('/api/v1/automation-runs')) {
      return Promise.resolve(new Response(JSON.stringify(opts.runs ?? [RUN]), { status: 200 }));
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

describe('AutomationPage', () => {
  it('is a valid React component', () => {
    expect(AutomationPage).toBeDefined();
    expect(typeof AutomationPage).toBe('function');
  });

  it(
    'lists rules and their run history in Russian',
    async () => {
      mockFetch();
      render(<AutomationPage />);

      expect(await screen.findByRole('heading', { level: 1, name: 'Автоматизация' })).toBeVisible();
      expect(await screen.findAllByText('Кик за спам')).toHaveLength(2);
      expect(screen.getByText('Выполнено')).toBeInTheDocument();
      expect(
        screen.getByRole('table', { name: 'История срабатываний правил автоматизации' }),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows empty states for both lists',
    async () => {
      mockFetch({ rules: [], runs: [] });
      render(<AutomationPage />);

      expect(await screen.findByText('Правил пока нет')).toBeInTheDocument();
      expect(screen.getByText('Срабатываний пока нет')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides management controls without the role:edit permission',
    async () => {
      mockFetch({ permissions: [] });
      render(<AutomationPage />);

      expect(await screen.findByText('Только просмотр')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Тест' })).not.toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Включить правило Кик за спам' })).toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the rule when the delete confirmation is cancelled',
    async () => {
      const { calls } = mockFetch();
      render(<AutomationPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Удалить правило Кик за спам' }));
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
      render(<AutomationPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Удалить правило Кик за спам' }));
      const dialog = await screen.findByRole('dialog', { name: 'Удалить правило' });
      expect(dialog).toHaveTextContent('Кик за спам');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить правило' }));

      await waitFor(() => {
        const deletes = calls.filter((call) => call.init?.method === 'DELETE');
        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.url).toBe('/api/v1/automation-rules/rule-1');
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports the outcome of a dry run without executing the action',
    async () => {
      const { calls } = mockFetch();
      render(<AutomationPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Тест' }));

      expect(await screen.findByText(/условие сработало/)).toBeInTheDocument();
      expect(calls.some((call) => call.url.endsWith('/dry-run'))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to create a rule without a name',
    async () => {
      const { calls } = mockFetch();
      render(<AutomationPage />);

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
      render(<AutomationPage />);

      fireEvent.change(await screen.findByLabelText('Имя'), { target: { value: 'Новое' } });
      fireEvent.click(screen.getByRole('button', { name: 'Добавить правило' }));

      await waitFor(() => {
        const posts = calls.filter((call) => call.init?.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(JSON.parse(String(posts[0]?.init?.body))).toMatchObject({
          name: 'Новое',
          condition_type: 'chat_keyword',
          action_type: 'warn',
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
      render(<AutomationPage />);

      expect(await screen.findByText('Не удалось загрузить автоматизацию')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
      await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(3));
    },
    TEST_TIMEOUT_MS,
  );
});
