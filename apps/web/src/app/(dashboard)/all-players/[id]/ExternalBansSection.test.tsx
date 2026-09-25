// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка внешних банлистов');

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

  it('opens a prefilled local-ban form for an active record and submits the selected server', async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/players/player-1/external-bans') {
        return Promise.resolve(new Response(JSON.stringify(TWO_SOURCES_RESPONSE), { status: 200 }));
      }
      if (url === '/api/v1/servers') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [{ id: 'server-1', display_name: 'Alpha Server' }] }),
            { status: 200 },
          ),
        );
      }
      if (url === '/api/v1/players/player-1/external-bans/b1/local-ban') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          server_id: 'server-1',
          reason: 'RuBans: aimbot',
          ban_length: '0',
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ExternalBansSection playerId="player-1" canBan />);
    await screen.findByText(/Найден в 2 внешних банлистах/);
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    const localBanButton = screen.getAllByRole('button', { name: 'Забанить локально' })[0];
    if (!localBanButton) throw new Error('local-ban button missing');
    fireEvent.click(localBanButton);

    expect(await screen.findByRole('dialog', { name: 'Забанить локально' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Alpha Server' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Причина/)).toHaveValue('RuBans: aimbot');
    expect(screen.getByLabelText(/Срок/)).toHaveValue('0');

    fireEvent.click(screen.getByRole('button', { name: 'Забанить' }));
    expect(
      await screen.findByText('Локальный бан отправлен на сервер «Alpha Server».'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/players/player-1/external-bans/b1/local-ban',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not expose local-ban actions without the Squad ban permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(TWO_SOURCES_RESPONSE), { status: 200 })),
      ),
    );

    render(<ExternalBansSection playerId="player-1" />);
    await screen.findByText(/Найден в 2 внешних банлистах/);
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    expect(screen.queryByRole('button', { name: 'Забанить локально' })).not.toBeInTheDocument();
  });
});
