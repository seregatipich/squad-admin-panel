// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

import ClanSettingsPanel, { type ClanSettingsInitial } from './ClanSettingsPanel';

const INITIAL: ClanSettingsInitial = {
  name: 'Альфа',
  description: 'Описание клана',
  tags: ['ALF', 'ONE'],
  max_priority_slots: 10,
  primary_server_id: null,
  is_public: true,
  priority_expires_at: null,
};

function mockFetch(handlers: {
  patchClan?: () => Promise<Response>;
  deleteClan?: () => Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'PATCH' && url === '/api/v1/clans/clan-1' && handlers.patchClan) {
      return handlers.patchClan();
    }
    if (init?.method === 'DELETE' && url === '/api/v1/clans/clan-1' && handlers.deleteClan) {
      return handlers.deleteClan();
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  pushMock.mockClear();
});

describe('ClanSettingsPanel', () => {
  it('renders a prefilled form from the initial clan data', () => {
    vi.stubGlobal('fetch', mockFetch({}));
    render(<ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />);
    expect(screen.getByDisplayValue('Альфа')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Описание клана')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ALF, ONE')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Публичный' })).toBeInTheDocument();
  });

  it('shows a Russian error banner when the core PATCH fails', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        patchClan: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: 'clan_name_taken' }), { status: 409 }),
          ),
      }),
    );
    const user = userEvent.setup();
    render(<ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(
      await screen.findByText('Не удалось сохранить изменения: clan_name_taken'),
    ).toBeInTheDocument();
  });

  it('keeps the disband button disabled during the 3s cooldown, then enables it', async () => {
    vi.stubGlobal('fetch', mockFetch({}));
    vi.useFakeTimers();
    render(<ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Расформировать клан' }));

    const confirmButton = screen.getByRole('button', { name: /Подтвердить \(\d+с\)/ });
    expect(confirmButton).toBeDisabled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(screen.getByRole('button', { name: 'Подтвердить расформирование' })).not.toBeDisabled();
  });

  it('redirects to /clans after a successful disband', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      mockFetch({
        deleteClan: () =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      }),
    );
    vi.useFakeTimers();
    render(<ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Расформировать клан' }));
    await vi.advanceTimersByTimeAsync(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить расформирование' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(pushMock).toHaveBeenCalledWith('/clans');
  });
});
