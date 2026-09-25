// @vitest-environment jsdom
// LEAD-7 (#178): season management. Mutations are gated on can_edit_roles,
// which GET /api/v1/me does not expose, so the page self-hides its controls on
// a 403 instead of reading a capability boolean.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SeasonsSettingsPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const UPCOMING = {
  id: 'season-next',
  name: 'Осень 2026',
  starts_at: '2026-09-01T00:00:00.000Z',
  ends_at: '2026-11-30T00:00:00.000Z',
  status: 'upcoming' as const,
  finalized: false,
};

const ACTIVE = {
  id: 'season-live',
  name: 'Лето 2026',
  starts_at: '2026-06-01T00:00:00.000Z',
  ends_at: '2026-08-31T00:00:00.000Z',
  status: 'active' as const,
  finalized: false,
};

const FROZEN = {
  id: 'season-old',
  name: 'Зима 2025',
  starts_at: '2025-12-01T00:00:00.000Z',
  ends_at: '2026-02-28T00:00:00.000Z',
  status: 'closed' as const,
  finalized: true,
};

interface StubOpts {
  items?: unknown[];
  listStatus?: number;
  mutationStatus?: number;
  mutationError?: string;
}

function stubFetch(opts: StubOpts = {}): {
  fn: ReturnType<typeof vi.fn>;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const items = opts.items ?? [ACTIVE, UPCOMING, FROZEN];
  const listStatus = opts.listStatus ?? 200;
  const mutationStatus = opts.mutationStatus ?? 200;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      const body =
        mutationStatus < 300
          ? JSON.stringify(ACTIVE)
          : JSON.stringify({ error: opts.mutationError ?? 'invalid_bounds' });
      return Promise.resolve(new Response(body, { status: mutationStatus }));
    }
    if (listStatus !== 200) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: listStatus }));
    }
    return Promise.resolve(new Response(JSON.stringify({ items }), { status: 200 }));
  });
  return { fn, calls };
}

async function renderPage(opts: StubOpts = {}) {
  const stub = stubFetch(opts);
  vi.stubGlobal('fetch', stub.fn);
  const view = render(<SeasonsSettingsPage />);
  await waitFor(() => expect(stub.calls.length).toBeGreaterThan(0));
  return { ...view, calls: stub.calls };
}

function fillForm(values: { name?: string; start?: string; end?: string }) {
  if (values.name !== undefined) {
    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: values.name } });
  }
  if (values.start !== undefined) {
    fireEvent.change(screen.getByLabelText(/Начало/), { target: { value: values.start } });
  }
  if (values.end !== undefined) {
    fireEvent.change(screen.getByLabelText(/Окончание/), { target: { value: values.end } });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('seasons settings page', () => {
  it(
    'lists seasons with their range and status',
    async () => {
      await renderPage();

      expect(await screen.findByText('Лето 2026')).toBeInTheDocument();
      expect(screen.getByText(/01\.06\.2026 — 31\.08\.2026/)).toBeInTheDocument();
      // Scoped to the table: the status words also appear as <option> labels in
      // the create form below it.
      const table = within(screen.getByRole('table'));
      expect(table.getByText(/Активный/)).toBeInTheDocument();
      expect(table.getByText(/Запланирован/)).toBeInTheDocument();
      expect(table.getByText(/финализирован/)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers no controls for a finalized season',
    async () => {
      await renderPage({ items: [FROZEN] });

      expect(await screen.findByText('Зима 2025')).toBeInTheDocument();
      expect(screen.getByText('только просмотр')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers Close only for the active season',
    async () => {
      await renderPage({ items: [ACTIVE, UPCOMING] });

      await screen.findByText('Лето 2026');
      expect(screen.getAllByRole('button', { name: 'Изменить' })).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: 'Закрыть' })).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the empty state when there are no seasons',
    async () => {
      await renderPage({ items: [] });
      expect(await screen.findByText('Сезонов пока нет')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing at all when the list itself is forbidden',
    async () => {
      const { container } = await renderPage({ listStatus: 403 });
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates a season and posts ISO instants derived from the date inputs',
    async () => {
      const { calls } = await renderPage({ items: [] });
      await screen.findByText('Сезонов пока нет');

      fillForm({ name: 'Весна 2027', start: '2027-03-01', end: '2027-05-31' });
      fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

      await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
      const post = calls.find((c) => c.init?.method === 'POST');
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        name: 'Весна 2027',
        starts_at: '2027-03-01T00:00:00.000Z',
        ends_at: '2027-05-31T00:00:00.000Z',
        status: 'upcoming',
      });
      expect(await screen.findByText('Сезон создан.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to submit an incomplete form without calling the API',
    async () => {
      const { calls } = await renderPage({ items: [] });
      await screen.findByText('Сезонов пока нет');

      fillForm({ name: 'Без дат' });
      fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

      expect(await screen.findByText('Заполните название и обе даты.')).toBeInTheDocument();
      expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'translates a server error code into Russian',
    async () => {
      await renderPage({ items: [], mutationStatus: 409, mutationError: 'active_season_exists' });
      await screen.findByText('Сезонов пока нет');

      fillForm({ name: 'Второй активный', start: '2027-03-01', end: '2027-05-31' });
      fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

      expect(
        await screen.findByText('Активный сезон уже существует — закройте текущий.'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'falls back to the status code for an unrecognised error',
    async () => {
      await renderPage({ items: [], mutationStatus: 500, mutationError: 'kaboom' });
      await screen.findByText('Сезонов пока нет');

      fillForm({ name: 'Ошибка', start: '2027-03-01', end: '2027-05-31' });
      fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

      expect(await screen.findByText('Ошибка 500')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'edits a season through PATCH and can be cancelled',
    async () => {
      const { calls } = await renderPage({ items: [UPCOMING] });
      await screen.findByText('Осень 2026');

      fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
      expect(screen.getByText('Изменение сезона')).toBeInTheDocument();

      fillForm({ name: 'Осень 2026 (правка)' });
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

      await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch?.url).toBe('/api/v1/seasons/season-next');
      expect(await screen.findByText('Сезон обновлён.')).toBeInTheDocument();
      expect(screen.getByText('Новый сезон')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'restores the create form when an edit is cancelled',
    async () => {
      await renderPage({ items: [UPCOMING] });
      await screen.findByText('Осень 2026');

      fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
      expect(screen.getByText('Изменение сезона')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
      expect(screen.getByText('Новый сезон')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'closes the active season through PATCH',
    async () => {
      const { calls } = await renderPage({ items: [ACTIVE] });
      await screen.findByText('Лето 2026');

      fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

      await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(JSON.parse(String(patch?.init?.body))).toEqual({ status: 'closed' });
      expect(await screen.findByText('Сезон закрыт.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces a server error raised while closing a season',
    async () => {
      await renderPage({ items: [ACTIVE], mutationStatus: 422, mutationError: 'season_finalized' });
      await screen.findByText('Лето 2026');

      fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

      expect(
        await screen.findByText('Сезон финализирован и больше не редактируется.'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the management surface for good once a mutation returns 403',
    async () => {
      await renderPage({ items: [UPCOMING], mutationStatus: 403 });
      await screen.findByText('Осень 2026');

      fillForm({ name: 'Нельзя', start: '2027-03-01', end: '2027-05-31' });
      fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

      expect(
        await screen.findByText('Управление сезонами требует права на редактирование ролей.'),
      ).toBeInTheDocument();
      // The list stays readable; only the controls go away.
      expect(screen.getByText('Осень 2026')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument();
      expect(screen.getByText('только просмотр')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the controls when closing a season returns 403',
    async () => {
      await renderPage({ items: [ACTIVE], mutationStatus: 403 });
      await screen.findByText('Лето 2026');

      fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

      expect(
        await screen.findByText('Управление сезонами требует права на редактирование ролей.'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
