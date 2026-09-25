// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RotationCalendarPage from './page';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/rotation-schedule')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              entries: [],
              history: [],
              profiles: [],
              warnings: {},
              can_edit: true,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [{ name: 'Yehorivka RAAS v11' }] }), { status: 200 }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RotationCalendarPage', () => {
  it('renders the calendar and weekly profile planner for changemap users', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <RotationCalendarPage params={Promise.resolve({ id: 'server-1' })} />
        </Suspense>,
      );
    });

    expect(await screen.findByTestId('rotation-calendar-grid')).toBeInTheDocument();
    expect(screen.getByTestId('rotation-profiles')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Добавить смену ротации' })).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Добавить профиль' })).toBeInTheDocument();
  });

  it('renders read-only mode without edit controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/rotation-schedule')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                entries: [],
                history: [],
                profiles: [{ name: 'Default', weekday: null, layers: ['Yehorivka RAAS v11'] }],
                warnings: {},
                can_edit: false,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ rows: [{ name: 'Yehorivka RAAS v11' }] }), { status: 200 }),
        );
      }),
    );
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <RotationCalendarPage params={Promise.resolve({ id: 'server-1' })} />
        </Suspense>,
      );
    });
    expect(
      await screen.findByText('Только просмотр — нужна squad-привилегия changemap.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Добавить профиль' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Название профиля')).toBeDisabled();
  });

  it('creates, edits, toggles, removes entries and saves profile changes', async () => {
    const entryDate = new Date();
    entryDate.setUTCHours(12, 0, 0, 0);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/rotation-schedule') && init?.method) {
        return Promise.resolve(new Response(JSON.stringify({ warnings: [] }), { status: 200 }));
      }
      if (url.includes('/rotation-schedule')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              entries: [
                {
                  id: 'entry-1',
                  scheduled_at: entryDate.toISOString(),
                  layer: 'Yehorivka RAAS v11',
                  mode: 'force_change',
                  enabled: true,
                },
              ],
              history: [
                {
                  id: 'match-1',
                  started_at: entryDate.toISOString(),
                  layer: 'Mutaha AAS v1',
                  map: null,
                },
              ],
              profiles: [{ name: 'Weekday', weekday: 1, layers: ['Yehorivka RAAS v11'] }],
              warnings: { 'entry-1': [{ type: 'overlap', message: 'Есть пересечение' }] },
              can_edit: true,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/rotation-profiles')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [{ name: 'Yehorivka RAAS v11' }] }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <RotationCalendarPage params={Promise.resolve({ id: 'server-1' })} />
        </Suspense>,
      );
    });
    expect(await screen.findByText(/Есть пересечение/)).toBeInTheDocument();
    expect(screen.getByText(/Mutaha AAS v1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Yehorivka RAAS v11/ }));
    expect(await screen.findByText('Изменить смену')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/servers/server-1/rotation-schedule/entry-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'выключить' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const entryDeleteButton = screen.getAllByRole('button', { name: 'удалить' })[0];
    if (!entryDeleteButton) throw new Error('entry delete button not found');
    fireEvent.click(entryDeleteButton);
    await waitFor(() => expect(screen.getByText('Запись удалена')).toBeInTheDocument());

    const addEntryButton = screen.getAllByRole('button', { name: 'Добавить смену ротации' })[0];
    if (!addEntryButton) throw new Error('add entry button not found');
    fireEvent.click(addEntryButton);
    expect(await screen.findByText('Новая смена')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.getByText('Запись создана')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Добавить профиль' }));
    expect(screen.getAllByLabelText('Название профиля')).toHaveLength(2);
    const firstProfileInput = screen.getAllByLabelText('Название профиля')[0];
    if (!firstProfileInput) throw new Error('profile input not found');
    fireEvent.change(firstProfileInput, {
      target: { value: 'Updated' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профили' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/servers/server-1/rotation-profiles',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const profileSection = screen.getByTestId('rotation-profiles');
    fireEvent.change(within(profileSection).getByLabelText('День профиля'), {
      target: { value: 'default' },
    });
    const profileDeleteButton = within(profileSection).getByRole('button', { name: 'удалить' });
    fireEvent.click(profileDeleteButton);
    expect(screen.getByText('Профили не настроены.')).toBeInTheDocument();
  }, 15_000);

  it('shows calendar and layer-load errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'calendar down' }), {
            status: url.includes('/rotation-schedule') ? 503 : 200,
          }),
        ),
      ),
    );
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <RotationCalendarPage params={Promise.resolve({ id: 'server-1' })} />
        </Suspense>,
      );
    });
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();

    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'layers down' }), {
            status: url.includes('/layers') ? 503 : 200,
          }),
        ),
      ),
    );
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <RotationCalendarPage params={Promise.resolve({ id: 'server-1' })} />
        </Suspense>,
      );
    });
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
  });

  it('surfaces failures from entry and profile mutations', async () => {
    const entryDate = new Date();
    entryDate.setUTCHours(12, 0, 0, 0);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method) {
          return Promise.resolve(new Response('down', { status: 503 }));
        }
        if (url.includes('/rotation-schedule')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                entries: [
                  {
                    id: 'entry-1',
                    scheduled_at: entryDate.toISOString(),
                    layer: 'Yehorivka RAAS v11',
                    mode: 'set_next',
                    enabled: true,
                  },
                ],
                history: [],
                profiles: [{ name: 'Weekday', weekday: 1, layers: [] }],
                warnings: {},
                can_edit: true,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith('/layers')) {
          return Promise.resolve(
            new Response(JSON.stringify({ rows: [{ name: 'Yehorivka RAAS v11' }] }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }),
    );
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <RotationCalendarPage params={Promise.resolve({ id: 'server-1' })} />
        </Suspense>,
      );
    });
    const calendarGrid = screen.getByTestId('rotation-calendar-grid');
    fireEvent.click(within(calendarGrid).getByRole('button', { name: /Yehorivka RAAS v11/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('HTTP 503: down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

    fireEvent.click(screen.getByRole('button', { name: 'выключить' }));
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByTestId('rotation-calendar-grid')).getByRole('button', { name: 'удалить' }),
    );
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профили' }));
    expect(await screen.findByText('HTTP 503: down')).toBeInTheDocument();
  });
});
