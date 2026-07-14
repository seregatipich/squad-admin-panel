// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaysWithSection } from './PlaysWithSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlaysWithSection', () => {
  it('renders the top co-play partners and compare links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              partners: [
                {
                  player_id: 'partner-1',
                  player_name: 'Частый напарник',
                  overlap_seconds: 7200,
                  shared_session_count: 10,
                  by_server: [],
                },
              ],
            }),
          ),
        ),
      ),
    );
    render(<PlaysWithSection playerId="player-1" />);
    expect(await screen.findByText('Частый напарник')).toBeInTheDocument();
    expect(screen.getByText('10 сессий')).toBeInTheDocument();
    expect(screen.getAllByText('Сравнить онлайн').length).toBeGreaterThan(0);
    const compareLink = screen
      .getAllByRole('link')
      .find((link) => link.textContent === 'Сравнить онлайн');
    expect(compareLink).toHaveAttribute('href', '/players/player-1/compare?other=partner-1');
  });

  it('hides on a panel-access denial', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
      ),
    );
    const { container } = render(<PlaysWithSection playerId="player-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an empty-state message when no partners clear the threshold', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ partners: [] }), { status: 200 }))),
    );
    render(<PlaysWithSection playerId="player-1" />);
    expect(
      await screen.findByText('Совместных игровых сессий выше порога не найдено.'),
    ).toBeInTheDocument();
  });

  it('renders a placeholder for a partner without a current name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              partners: [
                {
                  player_id: 'partner-2',
                  player_name: null,
                  overlap_seconds: 30,
                  shared_session_count: 1,
                },
              ],
            }),
          ),
        ),
      ),
    );
    render(<PlaysWithSection playerId="player-1" />);
    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.getByText('30с вместе')).toBeInTheDocument();
  });

  it('shows a request error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'down' }), { status: 503 })),
      ),
    );
    render(<PlaysWithSection playerId="player-1" />);
    expect(await screen.findByText('Ошибка: HTTP 503')).toBeInTheDocument();
  });
});
