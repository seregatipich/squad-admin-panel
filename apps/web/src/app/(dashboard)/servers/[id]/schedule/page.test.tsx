// @vitest-environment jsdom
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

const TEMPLATES = [
  {
    id: 't1',
    title: 'Rules',
    body: 'Welcome to {server}! Follow the rules.',
    category: 'info',
    locale: 'ru',
    sort_order: 1,
    is_enabled: true,
    created_by: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 't2',
    title: 'Discord',
    body: 'Join {server} Discord',
    category: 'info',
    locale: 'ru',
    sort_order: 2,
    is_enabled: true,
    created_by: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
];

const SERVERS = {
  items: [
    { id: 'srv-1', display_name: 'Alpha' },
    { id: 'srv-2', display_name: 'Bravo' },
    { id: 'srv-3', display_name: 'Charlie' },
  ],
  total: 3,
};

interface CapturedPost {
  url: string;
  // biome-ignore lint/suspicious/noExplicitAny: test captures arbitrary POST bodies
  body: any;
}

/** Broadcast-aware fetch mock: serves templates + servers and records POST bodies. */
function mockBroadcastFetch(): CapturedPost[] {
  const posts: CapturedPost[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/scheduled-tasks/history')) {
        return Promise.resolve(new Response(JSON.stringify({ runs: [] }), { status: 200 }));
      }
      if (url.endsWith('/scheduled-tasks')) {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(init.body as string) });
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'new-task', server_id: 'srv-1', also_created: [] }), {
              status: 201,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ tasks: [], capabilities: CAPABILITIES }), { status: 200 }),
        );
      }
      if (url.startsWith('/api/v1/layers')) {
        return Promise.resolve(new Response(JSON.stringify(LAYERS_POOL), { status: 200 }));
      }
      if (url.startsWith('/api/v1/message-templates')) {
        return Promise.resolve(new Response(JSON.stringify(TEMPLATES), { status: 200 }));
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify(SERVERS), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
  return posts;
}

async function selectBroadcast() {
  fireEvent.change(screen.getByLabelText('Тип задачи'), { target: { value: 'broadcast' } });
  await screen.findByTestId('broadcast-editor');
}

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

  describe('MSG-4 (#187): broadcast rotation, fan-out, and 5-minute floor', () => {
    it('renders the template picker only for the broadcast task type', async () => {
      mockBroadcastFetch();
      await renderPage();
      await screen.findByTestId('scheduled-tasks-list');

      // Default type is restart → no broadcast editor / template picker.
      expect(screen.queryByTestId('broadcast-editor')).not.toBeInTheDocument();

      await selectBroadcast();
      expect(screen.getByTestId('broadcast-editor')).toBeInTheDocument();
      expect(screen.getByText('Rules')).toBeInTheDocument();
      expect(screen.getByText('Discord')).toBeInTheDocument();
    });

    it('posts the ordered rotation with {server} substituted for two picked templates', async () => {
      const posts = mockBroadcastFetch();
      await renderPage();
      await screen.findByTestId('scheduled-tasks-list');
      await selectBroadcast();

      fireEvent.click(screen.getByText('Rules'));
      fireEvent.click(screen.getByText('Discord'));

      const rotation = screen.getByTestId('broadcast-rotation');
      expect(
        within(rotation).getByText(/Welcome to Alpha! Follow the rules\./),
      ).toBeInTheDocument();
      expect(within(rotation).getByText(/Join Alpha Discord/)).toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('Название задачи'), {
        target: { value: 'Rotation rules' },
      });
      fireEvent.change(screen.getByLabelText('Тип расписания'), { target: { value: 'cron' } });
      fireEvent.change(screen.getByPlaceholderText('* * * * *'), {
        target: { value: '*/30 * * * *' },
      });

      const submit = screen.getByRole('button', { name: 'Создать задачу' });
      expect(submit).toBeEnabled();
      await act(async () => {
        fireEvent.click(submit);
      });
      await screen.findByText('Задача создана');

      const post = posts.find((p) => p.body.task_type === 'broadcast');
      expect(post).toBeDefined();
      expect(post?.body.params.messages).toEqual([
        'Welcome to Alpha! Follow the rules.',
        'Join Alpha Discord',
      ]);
    });

    it('includes the selected servers as server_ids in the broadcast POST', async () => {
      const posts = mockBroadcastFetch();
      await renderPage();
      await screen.findByTestId('scheduled-tasks-list');
      await selectBroadcast();

      fireEvent.click(screen.getByText('Rules'));
      fireEvent.click(screen.getByLabelText('Bravo'));

      fireEvent.change(screen.getByPlaceholderText('Название задачи'), {
        target: { value: 'To Bravo too' },
      });
      fireEvent.change(screen.getByLabelText('Тип расписания'), { target: { value: 'cron' } });
      fireEvent.change(screen.getByPlaceholderText('* * * * *'), {
        target: { value: '0 * * * *' },
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Создать задачу' }));
      });
      await screen.findByText('Задача создана');

      const post = posts.find((p) => p.body.task_type === 'broadcast');
      expect(post?.body.server_ids).toEqual(['srv-2']);
    });

    it('disables submit and shows the 5-minute hint for a broadcast recurring more often than 5 minutes', async () => {
      mockBroadcastFetch();
      await renderPage();
      await screen.findByTestId('scheduled-tasks-list');
      await selectBroadcast();

      fireEvent.click(screen.getByText('Rules'));
      fireEvent.change(screen.getByPlaceholderText('Название задачи'), {
        target: { value: 'Spammy' },
      });
      fireEvent.change(screen.getByLabelText('Тип расписания'), { target: { value: 'cron' } });
      fireEvent.change(screen.getByPlaceholderText('* * * * *'), {
        target: { value: '*/2 * * * *' },
      });

      expect(screen.getByTestId('broadcast-interval-hint')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Создать задачу' })).toBeDisabled();

      // Loosening to every 5 minutes clears the hint and enables submit.
      fireEvent.change(screen.getByPlaceholderText('* * * * *'), {
        target: { value: '*/5 * * * *' },
      });
      expect(screen.queryByTestId('broadcast-interval-hint')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Создать задачу' })).toBeEnabled();
    });
  });
});
