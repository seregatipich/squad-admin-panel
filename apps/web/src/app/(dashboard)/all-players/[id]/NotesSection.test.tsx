// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveEvent, PlayerNote } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { NotesSection } from './NotesSection';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

const PLAYER_ID = 'b1e2c3d4-0000-0000-0000-000000000001';
const ME = { player_id: 'me-1', permissions: [] as string[] };

const handlers = new Map<string, (event: LiveEvent) => void>();

function note(overrides: Partial<PlayerNote> = {}): PlayerNote {
  return {
    id: 'note-1',
    player_id: PLAYER_ID,
    author: { id: 'me-1', name: 'Модератор', role_color: null },
    body: 'Первая заметка',
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: null,
    edited: false,
    ...overrides,
  } as PlayerNote;
}

function page(items: PlayerNote[], total = items.length) {
  return { items, next_cursor: null, total };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function emit(event: LiveEvent) {
  const handler = handlers.get(event.type);
  if (!handler) throw new Error(`no subscription for ${event.type}`);
  act(() => handler(event));
}

beforeEach(() => {
  handlers.clear();
  vi.mocked(useLiveSubscription).mockImplementation((type, handler) => {
    handlers.set(type, handler as (event: LiveEvent) => void);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NotesSection — live updates (#449)', () => {
  it('applies an edit made on another card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(page([note()])))),
    );
    render(<NotesSection playerId={PLAYER_ID} me={ME} />);
    await screen.findByText('Первая заметка');

    emit({
      type: 'note.updated',
      ts: '2026-07-01T11:00:00.000Z',
      data: { player_id: PLAYER_ID, note: note({ body: 'Исправлено', edited: true }) },
    });

    expect(screen.getByText('Исправлено')).toBeInTheDocument();
    expect(screen.queryByText('Первая заметка')).not.toBeInTheDocument();
    expect(screen.getByText('(изменено)')).toBeInTheDocument();
  });

  it('drops a note deleted on another card and lowers the count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(page([note(), note({ id: 'note-2', body: 'Вторая' })])))),
    );
    render(<NotesSection playerId={PLAYER_ID} me={ME} />);
    await screen.findByText('Вторая');

    emit({
      type: 'note.deleted',
      ts: '2026-07-01T11:00:00.000Z',
      data: { player_id: PLAYER_ID, note_id: 'note-2' },
    });

    expect(screen.queryByText('Вторая')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Заметки' }).parentElement).toHaveTextContent('1');
  });

  it('ignores live changes that belong to another player', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(page([note()])))),
    );
    render(<NotesSection playerId={PLAYER_ID} me={ME} />);
    await screen.findByText('Первая заметка');

    emit({
      type: 'note.deleted',
      ts: '2026-07-01T11:00:00.000Z',
      data: { player_id: 'someone-else', note_id: 'note-1' },
    });

    expect(screen.getByText('Первая заметка')).toBeInTheDocument();
  });

  it('keeps a note that arrived live while the first page was still loading', async () => {
    let releaseList: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releaseList = resolve;
          }),
      ),
    );
    render(<NotesSection playerId={PLAYER_ID} me={ME} />);

    emit({
      type: 'note.created',
      ts: '2026-07-01T12:00:00.000Z',
      data: { player_id: PLAYER_ID, note: note({ id: 'note-live', body: 'Живая' }) },
    });
    await act(async () => {
      releaseList(json(page([note()], 1)));
    });

    expect(screen.getByText('Живая')).toBeInTheDocument();
    expect(screen.getByText('Первая заметка')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Заметки' }).parentElement).toHaveTextContent('2');
  });
});

describe('NotesSection — error reporting (#448)', () => {
  it('reports a failed delete as a delete failure, without a reload button', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'DELETE' ? json({ error: 'note_not_found' }, 404) : json(page([note()])),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<NotesSection playerId={PLAYER_ID} me={ME} />);
    await screen.findByText('Первая заметка');

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить заметку' }));

    expect(await screen.findByText('Не удалось удалить заметку')).toBeInTheDocument();
    expect(screen.queryByText('Не удалось загрузить заметки')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
  });

  it('reports a failed send as a send failure and keeps the draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(init?.method === 'POST' ? json({}, 500) : json(page([]))),
      ),
    );
    render(<NotesSection playerId={PLAYER_ID} me={ME} />);
    await screen.findByText('Заметок нет');

    fireEvent.change(screen.getByRole('textbox', { name: 'Текст заметки' }), {
      target: { value: 'Черновик' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('Не удалось отправить заметку')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Текст заметки' })).toHaveValue('Черновик');
  });

  it('offers a retry for a failed load that reloads the list', async () => {
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(failing ? json({}, 500) : json(page([note()])))),
    );
    render(<NotesSection playerId={PLAYER_ID} me={ME} />);

    await screen.findByText('Не удалось загрузить заметки');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    await screen.findByText('Первая заметка');
    await waitFor(() =>
      expect(screen.queryByText('Не удалось загрузить заметки')).not.toBeInTheDocument(),
    );
  });
});
