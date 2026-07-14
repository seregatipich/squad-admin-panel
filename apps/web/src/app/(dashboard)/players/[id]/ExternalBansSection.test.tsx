// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalBansSection } from './ExternalBansSection';

const TWO_SOURCES_RESPONSE = {
  sources: [
    {
      source: { id: 's1', name: 'RuBans', trust_level: 'trusted', discord_url: null },
      bans: [
        {
          id: 'b1',
          nickname: 'Cheater',
          reason: 'aimbot',
          admin_name: 'Admin1',
          issued_at: '2026-01-01T00:00:00.000Z',
          expires_at: null,
          revoked_at: null,
          is_active: true,
          is_permanent: true,
        },
      ],
      active_count: 1,
    },
    {
      source: { id: 's2', name: 'CollaBans', trust_level: 'normal', discord_url: null },
      bans: [
        {
          id: 'b2',
          nickname: 'Cheater',
          reason: 'toxicity',
          admin_name: 'Admin2',
          issued_at: '2026-01-02T00:00:00.000Z',
          expires_at: '2027-01-01T00:00:00.000Z',
          revoked_at: null,
          is_active: true,
          is_permanent: false,
        },
      ],
      active_count: 1,
    },
  ],
  active_source_count: 2,
  total: 2,
};

const EMPTY_RESPONSE = { sources: [], active_source_count: 0, total: 0 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ExternalBansSection', () => {
  it('is a valid React component', () => {
    expect(ExternalBansSection).toBeDefined();
    expect(typeof ExternalBansSection).toBe('function');
  });

  it('renders "Найден в 2 внешних банлистах" from a mocked fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(TWO_SOURCES_RESPONSE), { status: 200 })),
      ),
    );

    render(<ExternalBansSection playerId="player-1" />);
    expect(screen.getByText('Загрузка…')).toBeInTheDocument();

    await screen.findByText(/Найден в 2 внешних банлистах/);
  });

  it('renders the green "not found" state for an empty response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(EMPTY_RESPONSE), { status: 200 }))),
    );

    render(<ExternalBansSection playerId="player-1" />);
    await screen.findByText(/Не найден во внешних банлистах/);
  });

  it('renders nothing on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
      ),
    );

    const { container } = render(<ExternalBansSection playerId="player-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
