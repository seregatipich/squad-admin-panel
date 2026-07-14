// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AltsSection } from './AltsSection';

const LINKS = {
  links: [
    {
      id: 'link-1',
      link_type: 'alt',
      status: 'confirmed',
      note: null,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      created_by: null,
      other_player: { id: 'confirmed-1', current_name: 'Подтверждённый', steam_id64: null },
    },
  ],
};

const candidate = (id: string, score: number) => ({
  player_id: id,
  current_name: id,
  steam_id64: null,
  shared_ip_count: 2,
  ignored_shared_ip_count: 0,
  min_time_delta_seconds: 90,
  score,
  confidence: 'high' as const,
  has_active_ban: false,
  has_permanent_ban: score === 100,
  signals: {
    shared_ips: { value: 2, weight: 50 },
    shared_names: { value: [], weight: 25 },
    young_account: { value: false, weight: 15 },
    steamid_proximity: { value: false, weight: 10 },
  },
  link: null,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AltsSection', () => {
  it('does not fetch ALT data until the section is expanded', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<AltsSection playerId="player-1" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts confirmed links first and shows the candidate signal details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/links') ? LINKS : { candidates: [candidate('Alt-1', 100)], total: 1 },
            ),
            { status: 200 },
          ),
        );
      }),
    );
    render(<AltsSection playerId="player-1" />);
    fireEvent.click(screen.getByText('Возможные альты'));
    expect(await screen.findByText('Подтверждённый')).toBeInTheDocument();
    expect(screen.getByText('Alt-1')).toBeInTheDocument();
    expect(screen.getByText('Общих IP: 2')).toBeInTheDocument();
    expect(screen.getByText('перманентный бан')).toBeInTheDocument();
  });

  it('hides entirely when a protected ALT endpoint returns 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
      ),
    );
    const { container } = render(<AltsSection playerId="player-1" />);
    fireEvent.click(screen.getByText('Возможные альты'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
