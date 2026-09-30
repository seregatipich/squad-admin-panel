// @vitest-environment happy-dom
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
    // Видимость названа словом, а не только положением тумблера.
    expect(screen.getByRole('switch', { name: 'Публичный клан' })).toBeChecked();
    expect(screen.getByText('Публичный')).toBeInTheDocument();
  });

  it('keeps unsaved edits when the parent re-renders with an equal but new initial object', () => {
    // Страница клана перерисовывается каждую секунду (тикер длительности сессий)
    // и передаёт `initial` свежим литералом.
    vi.stubGlobal('fetch', mockFetch({}));
    const { rerender } = render(
      <ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByDisplayValue('Альфа'), { target: { value: 'Альфа Прайм' } });
    fireEvent.change(screen.getByDisplayValue('Описание клана'), {
      target: { value: 'Новое описание' },
    });
    fireEvent.change(screen.getByDisplayValue('ALF, ONE'), { target: { value: 'ALF' } });
    fireEvent.change(screen.getByDisplayValue('10'), { target: { value: '12' } });

    rerender(
      <ClanSettingsPanel
        clanId="clan-1"
        initial={{ ...INITIAL, tags: [...INITIAL.tags] }}
        servers={[]}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('Альфа Прайм')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Новое описание')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ALF')).toBeInTheDocument();
    expect(screen.getByDisplayValue('12')).toBeInTheDocument();
  });

  it('refills the form when the clan itself changes on the server', () => {
    vi.stubGlobal('fetch', mockFetch({}));
    const { rerender } = render(
      <ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByDisplayValue('Альфа'), { target: { value: 'черновик' } });

    rerender(
      <ClanSettingsPanel
        clanId="clan-1"
        initial={{ ...INITIAL, name: 'Бета', tags: ['BET'] }}
        servers={[]}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('Бета')).toBeInTheDocument();
    expect(screen.getByDisplayValue('BET')).toBeInTheDocument();
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
      await screen.findByText('Не удалось сохранить изменения: название уже занято'),
    ).toBeInTheDocument();
  });

  it('never shows a raw API code or English network error to the user', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        patchClan: () =>
          Promise.resolve(new Response(JSON.stringify({ error: 'weird_code' }), { status: 500 })),
      }),
    );
    const user = userEvent.setup();
    render(<ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(
      await screen.findByText('Не удалось сохранить изменения: неизвестная ошибка'),
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

  it('требует набрать название клана в диалоге, прежде чем расформировать', async () => {
    vi.stubGlobal('fetch', mockFetch({}));
    vi.useFakeTimers();
    render(<ClanSettingsPanel clanId="clan-1" initial={INITIAL} servers={[]} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Расформировать клан' }));
    await vi.advanceTimersByTimeAsync(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить расформирование' }));

    const confirm = screen.getByRole('button', { name: 'Расформировать навсегда' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Введите название клана/), {
      target: { value: 'Бета' },
    });
    expect(screen.getByRole('button', { name: 'Расформировать навсегда' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Введите название клана/), {
      target: { value: 'Альфа' },
    });
    expect(screen.getByRole('button', { name: 'Расформировать навсегда' })).not.toBeDisabled();
  });

  it('redirects to /clans after a successful disband', async () => {
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
    fireEvent.change(screen.getByLabelText(/Введите название клана/), {
      target: { value: 'Альфа' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Расформировать навсегда' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(pushMock).toHaveBeenCalledWith('/clans');
  });
});
