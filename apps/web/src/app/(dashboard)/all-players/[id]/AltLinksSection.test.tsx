// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AltLinksSection } from './AltLinksSection';

const LINKS_RESPONSE = {
  links: [
    {
      id: 'link-1',
      link_type: 'alt',
      status: 'confirmed',
      note: null,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      created_by: { player_id: 'admin-1', name: 'Owner' },
      other_player: { id: 'player-confirmed', current_name: 'ConfirmedAlt', steam_id64: null },
    },
  ],
};

const CANDIDATES_RESPONSE = {
  candidates: [
    {
      player_id: 'player-candidate',
      current_name: 'SuspectTwin',
      steam_id64: '76561198000000002',
      shared_ip_count: 2,
      ignored_shared_ip_count: 0,
      min_time_delta_seconds: 90,
      score: 75,
      confidence: 'high',
      has_active_ban: false,
      has_permanent_ban: false,
      signals: {
        shared_ips: { value: 2, weight: 50 },
        shared_names: { value: [], weight: 25 },
        young_account: { value: false, weight: 15 },
        steamid_proximity: { value: false, weight: 10 },
      },
      link: null,
    },
  ],
};

function mockFetchSequence(responses: Array<{ status: number; body?: unknown }>) {
  let call = 0;
  return vi.fn(() => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(
      new Response(response.body !== undefined ? JSON.stringify(response.body) : undefined, {
        status: response.status,
      }),
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AltLinksSection', () => {
  it('is a valid React component', () => {
    expect(AltLinksSection).toBeDefined();
    expect(typeof AltLinksSection).toBe('function');
  });

  it('announces a loading state before data resolves', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    render(<AltLinksSection playerId="player-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка связей');
  });

  it('returns null (hides entirely) when the links fetch is forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchSequence([
        { status: 403, body: { error: 'forbidden' } },
        { status: 403, body: { error: 'forbidden' } },
      ]),
    );
    const { container } = render(<AltLinksSection playerId="player-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders a confirmed link badge and confirm/reject buttons from mocked responses', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchSequence([
        { status: 200, body: LINKS_RESPONSE },
        { status: 200, body: CANDIDATES_RESPONSE },
      ]),
    );
    render(<AltLinksSection playerId="player-1" />);

    const confirmedRow = (await screen.findByText('ConfirmedAlt')).closest('li');
    if (!confirmedRow) throw new Error('confirmed link row not found');
    expect(within(confirmedRow).getByText('Альт')).toBeInTheDocument();

    expect(screen.getByText('SuspectTwin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подтвердить связь' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeInTheDocument();
  });
});
