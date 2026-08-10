// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(ROSTER), { status: 200 }))),
  );
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
