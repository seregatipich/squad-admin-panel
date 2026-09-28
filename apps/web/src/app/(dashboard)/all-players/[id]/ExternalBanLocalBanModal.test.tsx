// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalBanLocalBanModal,
  type ExternalBanLocalBanTarget,
} from './ExternalBanLocalBanModal';

const TARGET: ExternalBanLocalBanTarget = {
  id: 'ext-ban-1',
  sourceName: 'RuBans',
  reason: 'читы',
};

const SERVERS = {
  items: [
    { id: 'srv-1', display_name: 'RU #1' },
    { id: 'srv-2', display_name: 'RU #2' },
  ],
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init)),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ExternalBanLocalBanModal', () => {
  it('does not preselect a server, matching the "explicit choice" docstring (#442)', async () => {
    stubFetch(() => new Response(JSON.stringify(SERVERS), { status: 200 }));
    render(
      <ExternalBanLocalBanModal
        playerId="player-1"
        target={TARGET}
        onClose={() => {}}
        onBanned={() => {}}
      />,
    );

    const select = (await screen.findByRole('combobox', { name: 'Сервер' })) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('button', { name: 'Забанить' })).toBeDisabled();
  });

  it('shows a Russian message for a known local-ban error code (#443)', async () => {
    let call = 0;
    stubFetch((url) => {
      call += 1;
      if (url === '/api/v1/servers') return new Response(JSON.stringify(SERVERS), { status: 200 });
      return new Response(JSON.stringify({ error: 'external_ban_inactive' }), { status: 409 });
    });
    render(
      <ExternalBanLocalBanModal
        playerId="player-1"
        target={TARGET}
        onClose={() => {}}
        onBanned={() => {}}
      />,
    );

    const select = (await screen.findByRole('combobox', { name: 'Сервер' })) as HTMLSelectElement;
    await userEvent.selectOptions(select, 'srv-1');
    await userEvent.click(screen.getByRole('button', { name: 'Забанить' }));

    expect(await screen.findByText('Внешний бан уже неактивен.')).toBeInTheDocument();
    expect(screen.queryByText(/external_ban_inactive/)).not.toBeInTheDocument();
    expect(call).toBeGreaterThan(1);
  });

  it('shows the field-level message for a 400 validation error instead of "Bad Request" (#443)', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/servers') return new Response(JSON.stringify(SERVERS), { status: 200 });
      return new Response(
        JSON.stringify({ error: 'Bad Request', message: 'ban_length must match \\d+[smhdwMy]?' }),
        { status: 400 },
      );
    });
    render(
      <ExternalBanLocalBanModal
        playerId="player-1"
        target={TARGET}
        onClose={() => {}}
        onBanned={() => {}}
      />,
    );

    const select = (await screen.findByRole('combobox', { name: 'Сервер' })) as HTMLSelectElement;
    await userEvent.selectOptions(select, 'srv-1');
    await userEvent.click(screen.getByRole('button', { name: 'Забанить' }));

    expect(await screen.findByText('ban_length must match \\d+[smhdwMy]?')).toBeInTheDocument();
    expect(screen.queryByText('Bad Request')).not.toBeInTheDocument();
  });
});
