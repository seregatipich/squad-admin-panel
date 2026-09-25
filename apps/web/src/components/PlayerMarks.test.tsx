// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import { PlayerMarks } from './PlayerMarks';

const MARK_TYPE = {
  id: 5,
  slug: 'danger',
  label_en: 'Danger',
  label_ru: 'Опасность',
  icon: 'skull',
  severity: 5,
  sort_order: 1,
};

const ACTIVE_MARK = {
  id: 'mark-1',
  player_id: 'player-1',
  mark_type_id: 5,
  comment: null,
  created_by: 'admin-1',
  created_by_name: 'Админ',
  created_at: new Date('2026-01-02T03:04:05Z').toISOString(),
  cleared_by: null,
  cleared_by_name: null,
  cleared_at: null,
  clear_reason: null,
  active: true,
  mark_type: MARK_TYPE,
};

function stubFetch(marks: unknown[]) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v1/mark-types') {
      return Promise.resolve(new Response(JSON.stringify([MARK_TYPE]), { status: 200 }));
    }
    if (url.includes('/marks?include_cleared')) {
      return Promise.resolve(new Response(JSON.stringify({ items: marks }), { status: 200 }));
    }
    if (init?.method === 'DELETE' || init?.method === 'POST') {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlayerMarks', () => {
  it('opens a real menu: the trigger owns aria-haspopup and the items are menu items', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    render(<PlayerMarks playerId="player-1" />);

    const trigger = await screen.findByRole('button', { name: 'Метки подозрения' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByRole('menuitem', { name: /Опасность/ })).toBeInTheDocument();
  });

  it('sets a mark through the menu', async () => {
    const fetchMock = stubFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    render(<PlayerMarks playerId="player-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Метки подозрения' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Опасность/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/players/player-1/marks',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('asks for confirmation in a dialog before clearing a mark', async () => {
    const fetchMock = stubFetch([ACTIVE_MARK]);
    vi.stubGlobal('fetch', fetchMock);
    render(<PlayerMarks playerId="player-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Снять' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Опасность/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/v1/players/player-1/marks/mark-1',
      expect.objectContaining({ method: 'DELETE' }),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Снять метку' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/players/player-1/marks/mark-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('keeps the mark when the confirmation is cancelled', async () => {
    const fetchMock = stubFetch([ACTIVE_MARK]);
    vi.stubGlobal('fetch', fetchMock);
    render(<PlayerMarks playerId="player-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Снять' }));
    const dialog = await screen.findByRole('dialog');
    // «Отмена» носят и кнопка подвала, и крестик окна: нужен именно подвал.
    const cancels = within(dialog).getAllByRole('button', { name: 'Отмена' });
    fireEvent.click(cancels[cancels.length - 1] as HTMLElement);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/v1/players/player-1/marks/mark-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('tells the operator when no mark is active', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    render(<PlayerMarks playerId="player-1" />);

    expect(await screen.findByText('Активных меток нет')).toBeInTheDocument();
  });
});
