// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordLinkSection } from './DiscordLinkSection';
import type { DiscordLinkResponse } from './discord-link';

const TEST_TIMEOUT_MS = 15_000;
const SELF = { player_id: 'player-alpha' };
const OTHER = { player_id: 'player-omega' };

function linked(overrides: Partial<DiscordLinkResponse> = {}): DiscordLinkResponse {
  return {
    linked: true,
    discord_user_id: '111222333444555666',
    discord_username: 'Сквадди',
    linked_at: '2026-07-20T10:30:00.000Z',
    ...overrides,
  };
}

const unlinked: DiscordLinkResponse = {
  linked: false,
  discord_user_id: null,
  discord_username: null,
  linked_at: null,
};

function stubFetch(status: number, body?: unknown) {
  const mock = vi.fn(() =>
    Promise.resolve(new Response(body !== undefined ? JSON.stringify(body) : null, { status })),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** GET returns `first`, every later call (the DELETE) returns `then`. */
function stubFetchSequence(first: { status: number; body?: unknown }, then: { status: number }) {
  let call = 0;
  const mock = vi.fn(() => {
    call += 1;
    if (call === 1) {
      return Promise.resolve(
        new Response(first.body !== undefined ? JSON.stringify(first.body) : null, {
          status: first.status,
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: then.status }));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DiscordLinkSection', () => {
  it(
    'renders the linked username and the link date',
    async () => {
      stubFetch(200, linked());
      render(<DiscordLinkSection playerId="player-alpha" me={SELF} />);

      await screen.findByText('Discord');
      expect(screen.getByText('Сквадди')).toBeInTheDocument();
      expect(screen.getByText(/Привязан/)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the API responds with 401',
    async () => {
      stubFetch(401);
      const { container } = render(<DiscordLinkSection playerId="player-alpha" me={SELF} />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the API responds with 403',
    async () => {
      stubFetch(403);
      const { container } = render(<DiscordLinkSection playerId="player-alpha" me={SELF} />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an error state on a 500 response',
    async () => {
      stubFetch(500);
      render(<DiscordLinkSection playerId="player-alpha" me={SELF} />);

      await screen.findByText(/Ошибка загрузки Discord-линковки/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers the OAuth login link on the caller own unlinked card',
    async () => {
      stubFetch(200, unlinked);
      render(<DiscordLinkSection playerId="player-alpha" me={SELF} />);

      const link = await screen.findByRole('link', { name: 'Привязать Discord' });
      expect(link).toHaveAttribute('href', '/api/v1/auth/discord/login');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a plain empty state on a foreign unlinked card without a link button',
    async () => {
      stubFetch(200, unlinked);
      render(<DiscordLinkSection playerId="player-alpha" me={OTHER} />);

      await screen.findByText('Discord не привязан.');
      expect(screen.queryByRole('link', { name: 'Привязать Discord' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'self-unlink calls the me endpoint and clears the section state',
    async () => {
      const mock = stubFetchSequence({ status: 200, body: linked() }, { status: 200 });
      render(<DiscordLinkSection playerId="player-alpha" me={SELF} />);

      const button = await screen.findByRole('button', { name: 'Отвязать' });
      await userEvent.click(button);

      await screen.findByText('Discord не привязан.');
      const deleteCall = mock.mock.calls[1] as unknown as [string, RequestInit];
      expect(deleteCall[0]).toBe('/api/v1/players/me/discord/link');
      expect(deleteCall[1].method).toBe('DELETE');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'force-unlink on a foreign card calls the player-scoped endpoint',
    async () => {
      const mock = stubFetchSequence({ status: 200, body: linked() }, { status: 200 });
      render(<DiscordLinkSection playerId="player-alpha" me={OTHER} />);

      const button = await screen.findByRole('button', { name: 'Отвязать принудительно' });
      await userEvent.click(button);

      await screen.findByText('Discord не привязан.');
      const deleteCall = mock.mock.calls[1] as unknown as [string, RequestInit];
      expect(deleteCall[0]).toBe('/api/v1/players/player-alpha/discord/link');
      expect(deleteCall[1].method).toBe('DELETE');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the force-unlink button when the API answers 403 (self-hide-on-403)',
    async () => {
      stubFetchSequence({ status: 200, body: linked() }, { status: 403 });
      render(<DiscordLinkSection playerId="player-alpha" me={OTHER} />);

      const button = await screen.findByRole('button', { name: 'Отвязать принудительно' });
      await userEvent.click(button);

      await screen.findByText('Недостаточно прав для принудительной отвязки.');
      expect(
        screen.queryByRole('button', { name: 'Отвязать принудительно' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Сквадди')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders no action button while the viewer identity is still unknown',
    async () => {
      stubFetch(200, linked());
      render(<DiscordLinkSection playerId="player-alpha" me={null} />);

      await screen.findByText('Сквадди');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
