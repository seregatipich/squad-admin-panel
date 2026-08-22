// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import { LivePlayers } from './live-players';

const TEST_TIMEOUT_MS = 15_000;

const ROSTER = {
  polled_at: '2026-07-09T10:00:00.000Z',
  players: [
    {
      player_id: '019e2000-0000-7000-8000-0000000000aa',
      rcon_id: 0,
      eos_id: 'eos-leader',
      steam_id64: '76561198000000001',
      name: 'Leader',
      team_id: 1,
      squad_id: 2,
      is_leader: true,
      role: null,
      first_seen_at: '2026-07-09T09:55:00.000Z',
    },
    {
      player_id: null,
      rcon_id: 1,
      eos_id: 'eos-mate',
      steam_id64: '76561198000000002',
      name: 'Mate',
      team_id: 1,
      squad_id: 2,
      is_leader: false,
      role: null,
      first_seen_at: '2026-07-09T09:56:00.000Z',
    },
  ],
};

/**
 * jsdom знает `<dialog>`, но не реализует `showModal()`/`close()`. Быстрые
 * действия строятся на нативном элементе, поэтому тест воспроизводит ровно то,
 * на что примитив опирается.
 */
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

/** Ростер на GET, отчёт «применено» на POST массового действия. */
function stubRosterFetch(
  bulkResult: { applied: number; failed: number; results: unknown[] } = {
    applied: 1,
    failed: 0,
    results: [{ player_id: 'x', status: 'applied' }],
  },
) {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify(bulkResult), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(ROSTER), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bulkPosts(fetchMock: ReturnType<typeof stubRosterFetch>) {
  return fetchMock.mock.calls.filter(
    (call) => call[0] === '/api/v1/moderation-actions/bulk' && call[1]?.method === 'POST',
  );
}

beforeEach(() => {
  stubRosterFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LivePlayers', () => {
  it('is a valid React component', () => {
    expect(LivePlayers).toBeDefined();
    expect(typeof LivePlayers).toBe('function');
  });

  it(
    'hides the per-squad message button without the chat permission',
    async () => {
      render(<LivePlayers serverId="srv-1" canChat={false} />);
      await screen.findByText('Leader');
      expect(screen.queryByRole('button', { name: /сообщение отряду/i })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a per-squad message button with the chat permission',
    async () => {
      render(<LivePlayers serverId="srv-1" canChat={true} />);
      await screen.findByText('Leader');
      expect(screen.getByRole('button', { name: /сообщение отряду/i })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the per-player message button without the chat permission',
    async () => {
      render(<LivePlayers serverId="srv-1" canChat={false} />);
      await screen.findByText('Leader');
      expect(screen.queryByRole('button', { name: /сообщение игроку/i })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a per-player message button for a resolved roster player',
    async () => {
      render(<LivePlayers serverId="srv-1" canChat={true} />);
      await screen.findByText('Leader');
      // Only `Leader` carries a resolved player_id; `Mate` has none and gets no button.
      const buttons = screen.getAllByRole('button', { name: /сообщение игроку/i });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAttribute('aria-label', 'Сообщение игроку: Leader');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the per-player «Забанить ник» button without the ban permission',
    async () => {
      render(<LivePlayers serverId="srv-1" canBan={false} />);
      await screen.findByText('Leader');
      expect(screen.queryByRole('button', { name: /забанить ник/i })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a per-player «Забанить ник» button with the ban permission, prefilling the modal with the roster name',
    async () => {
      render(<LivePlayers serverId="srv-1" canBan={true} />);
      await screen.findByText('Leader');
      const buttons = screen.getAllByRole('button', { name: /забанить ник «leader»/i });
      fireEvent.click(buttons[0]);
      const patternInput = (await screen.findByLabelText(/паттерн/i)) as HTMLInputElement;
      expect(patternInput.value).toBe('Leader');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the bulk selection column without any mod:* catalog key',
    async () => {
      render(<LivePlayers serverId="srv-1" modPermissions={[]} />);
      await screen.findByText('Leader');
      expect(screen.queryByLabelText('Выделить всех')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Выбрать игрока: Leader')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers a checkbox only for roster rows with a resolved player id',
    async () => {
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:kick']} />);
      await screen.findByText('Leader');
      expect(screen.getByLabelText('Выбрать игрока: Leader')).toBeEnabled();
      expect(screen.getByLabelText('Выбрать игрока: Mate')).toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reveals the bulk action bar once a player is selected and clears it again',
    async () => {
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:kick']} />);
      await screen.findByText('Leader');
      expect(screen.queryByRole('button', { name: 'Массовое действие' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Выбрать игрока: Leader'));
      expect(screen.getByText('Выбрано: 1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Массовое действие' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Снять выделение' }));
      expect(screen.queryByRole('button', { name: 'Массовое действие' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'selects every selectable player at once',
    async () => {
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:kick', 'mod:ban_perm']} />);
      await screen.findByText('Leader');
      fireEvent.click(screen.getByLabelText('Выделить всех'));
      // Only `Leader` carries a resolved player_id; `Mate` cannot be targeted.
      expect(screen.getByText('Выбрано: 1')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'opens the bulk moderation modal with the selected targets',
    async () => {
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:kick']} />);
      await screen.findByText('Leader');
      fireEvent.click(screen.getByLabelText('Выбрать игрока: Leader'));
      fireEvent.click(screen.getByRole('button', { name: 'Массовое действие' }));
      expect(await screen.findByText('Выбрано игроков: 1')).toBeInTheDocument();
      expect(screen.getByLabelText('Действие')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('LivePlayers — быстрые действия над игроком', () => {
  it(
    'hides the row actions without the matching mod:* keys',
    async () => {
      render(<LivePlayers serverId="srv-1" modPermissions={[]} />);
      await screen.findByText('Leader');
      expect(
        screen.queryByRole('button', { name: 'Предупредить: Leader' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Кик: Leader' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Бан: Leader' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows one row action per granted key, and only for a resolved roster player',
    async () => {
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:warn', 'mod:kick']} />);
      await screen.findByText('Leader');
      expect(screen.getByRole('button', { name: 'Предупредить: Leader' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Кик: Leader' })).toBeInTheDocument();
      // Только `mod:ban_temp`/`mod:ban_perm` открывают бан.
      expect(screen.queryByRole('button', { name: 'Бан: Leader' })).not.toBeInTheDocument();
      // `Mate` не сопоставлен с профилем панели — целью действия быть не может.
      expect(screen.queryByRole('button', { name: 'Кик: Mate' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'links every resolved roster player to their dossier',
    async () => {
      render(<LivePlayers serverId="srv-1" />);
      await screen.findByText('Leader');
      expect(screen.getByRole('link', { name: 'Досье: Leader' })).toHaveAttribute(
        'href',
        '/all-players/019e2000-0000-7000-8000-0000000000aa',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to kick without a reason and posts a single-target kick once one is given',
    async () => {
      const fetchMock = stubRosterFetch();
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:kick']} />);
      await screen.findByText('Leader');

      fireEvent.click(screen.getByRole('button', { name: 'Кик: Leader' }));
      expect(await screen.findByRole('heading', { name: 'Кикнуть игрока' })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Кик' }));
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('Укажите причину');
      expect(bulkPosts(fetchMock)).toHaveLength(0);

      fireEvent.change(screen.getByLabelText(/Причина/), { target: { value: 'тимкил' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Кик' }));
      });

      await waitFor(() => expect(bulkPosts(fetchMock)).toHaveLength(1));
      const body = JSON.parse(String(bulkPosts(fetchMock)[0]?.[1]?.body));
      expect(body).toMatchObject({
        server_id: 'srv-1',
        action_type: 'kick',
        player_ids: ['019e2000-0000-7000-8000-0000000000aa'],
        reason: 'тимкил',
        confirm_bulk: true,
      });
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Кикнуть игрока' })).not.toBeInTheDocument(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'asks a single ban for a duration but not for the bulk count challenge',
    async () => {
      const fetchMock = stubRosterFetch();
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:ban_temp']} />);
      await screen.findByText('Leader');

      fireEvent.click(screen.getByRole('button', { name: 'Бан: Leader' }));
      await screen.findByRole('heading', { name: 'Забанить игрока' });

      expect(screen.getByLabelText(/Срок бана/)).toBeInTheDocument();
      // Навсегда доступно только с `mod:ban_perm`.
      expect(screen.queryByRole('option', { name: 'Навсегда' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/количество целей/i)).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/Причина/), { target: { value: 'читы' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Забанить' }));
      });

      await waitFor(() => expect(bulkPosts(fetchMock)).toHaveLength(1));
      const body = JSON.parse(String(bulkPosts(fetchMock)[0]?.[1]?.body));
      expect(body).toMatchObject({ action_type: 'ban', ban_length: '1d' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the dialog open and explains why a target was not affected',
    async () => {
      stubRosterFetch({
        applied: 0,
        failed: 1,
        results: [
          {
            player_id: '019e2000-0000-7000-8000-0000000000aa',
            status: 'failed',
            error: 'target_offline',
          },
        ],
      });
      render(<LivePlayers serverId="srv-1" modPermissions={['mod:warn']} />);
      await screen.findByText('Leader');

      fireEvent.click(screen.getByRole('button', { name: 'Предупредить: Leader' }));
      fireEvent.change(await screen.findByLabelText(/Причина/), { target: { value: 'мат' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Предупредить' }));
      });

      expect(await screen.findByRole('alert')).toHaveTextContent('Игрок не в сети');
      expect(screen.getByRole('heading', { name: 'Предупредить игрока' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
