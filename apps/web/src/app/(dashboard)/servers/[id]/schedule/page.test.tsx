// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/srv-1/schedule'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import SchedulePage from './page';

const TASKS = [
  {
    id: 'task-1',
    server_id: 'srv-1',
    name: 'Nightly restart',
    task_type: 'restart',
    params: {},
    scheduled_at: null,
    recurrence: '0 5 * * *',
    enabled: true,
    created_by: null,
    last_executed_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
];

const CAPABILITIES = {
  restart: true,
  set_next_layer: true,
  change_layer: true,
  broadcast: true,
};

const RUNS = [
  {
    id: 'run-1',
    task_id: 'task-1',
    task_name: 'Nightly restart',
    task_type: 'restart',
    executed_at: '2026-07-02T05:00:00.000Z',
    status: 'executed',
    detail: { command: 'restart' },
  },
];

const LAYERS_POOL = {
  rows: [
    { id: 'l1', name: 'Yehorivka RAAS v1' },
    { id: 'l2', name: 'Narva RAAS v1' },
  ],
};

function mockFetch(capabilities = CAPABILITIES, opts: { fail?: 'list' | 'history' } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/scheduled-tasks/history')) {
        if (opts.fail === 'history') return Promise.resolve(new Response('boom', { status: 500 }));
        return Promise.resolve(new Response(JSON.stringify({ runs: RUNS }), { status: 200 }));
      }
      if (url.endsWith('/scheduled-tasks')) {
        if (opts.fail === 'list') return Promise.resolve(new Response('boom', { status: 500 }));
        return Promise.resolve(
          new Response(JSON.stringify({ tasks: TASKS, capabilities }), { status: 200 }),
        );
      }
      if (url.startsWith('/api/v1/layers')) {
        return Promise.resolve(new Response(JSON.stringify(LAYERS_POOL), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <SchedulePage params={Promise.resolve({ id: 'srv-1' })} />
      </Suspense>,
    );
  });
}

describe('SchedulePage', () => {
  it('is a valid React component', () => {
    expect(SchedulePage).toBeDefined();
    expect(typeof SchedulePage).toBe('function');
  });

  it('renders the task list with the loaded task', async () => {
    await renderPage();
    const list = await screen.findByTestId('scheduled-tasks-list');
    expect(within(list).getByText('Nightly restart')).toBeInTheDocument();
    expect(within(list).getByText(/0 5 \* \* \*/)).toBeInTheDocument();
  });

  it('renders the execution history', async () => {
    await renderPage();
    await screen.findByTestId('scheduled-tasks-history');
    expect(screen.getByText(/Выполнено/)).toBeInTheDocument();
  });

  it('shows an error message when the tasks fetch fails', async () => {
    mockFetch(CAPABILITIES, { fail: 'list' });
    await renderPage();
    await screen.findByText(/HTTP 500/);
  });

  it('shows create/delete controls with edit capabilities', async () => {
    await renderPage();
    await screen.findByTestId('scheduled-tasks-list');
    expect(screen.getByRole('button', { name: 'Создать задачу' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'удалить' })).toBeInTheDocument();
  });

  it('hides controls and shows a read-only note without any edit capability', async () => {
    mockFetch({ restart: false, set_next_layer: false, change_layer: false, broadcast: false });
    await renderPage();
    await screen.findByTestId('scheduled-tasks-list');
    expect(screen.queryByRole('button', { name: 'Создать задачу' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'удалить' })).not.toBeInTheDocument();
    expect(screen.getByText(/Только просмотр/)).toBeInTheDocument();
  });

  it('validates the create form: the submit button enables only once required fields are filled', async () => {
    await renderPage();
    await screen.findByTestId('scheduled-tasks-list');

    const submit = screen.getByRole('button', { name: 'Создать задачу' });
    // Default type is restart, schedule mode one-off — name and datetime are required.
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Название задачи'), {
      target: { value: 'Evening restart' },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Дата и время'), {
      target: { value: '2026-08-01T05:00' },
    });
    expect(submit).toBeEnabled();
  });

  it('rejects an invalid cron expression in the recurring mode', async () => {
    await renderPage();
    await screen.findByTestId('scheduled-tasks-list');

    fireEvent.change(screen.getByPlaceholderText('Название задачи'), {
      target: { value: 'Cron task' },
    });
    fireEvent.change(screen.getByLabelText('Тип расписания'), {
      target: { value: 'cron' },
    });
    fireEvent.change(screen.getByPlaceholderText('* * * * *'), {
      target: { value: 'not a cron' },
    });
    expect(screen.getByRole('button', { name: 'Создать задачу' })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('* * * * *'), {
      target: { value: '0 5 * * *' },
    });
    expect(screen.getByRole('button', { name: 'Создать задачу' })).toBeEnabled();
  });
});
