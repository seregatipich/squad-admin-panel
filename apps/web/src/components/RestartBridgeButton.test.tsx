// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestartBridgeButton } from './RestartBridgeButton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockFetch(response: Response | (() => Promise<Response>)) {
  const fn = typeof response === 'function' ? response : () => Promise.resolve(response);
  const spy = vi.fn(fn);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Перезапустить агент' }));
}

/** Подтверждающая кнопка называется так же, как триггер, — берём её внутри окна. */
function confirmButton() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Перезапустить агент' });
}

/** Крестик и кнопка отказа делят одну подпись — это один и тот же выход. */
function exits(name: string) {
  return within(screen.getByRole('dialog')).getAllByRole('button', { name });
}

describe('RestartBridgeButton', () => {
  it('exports a React component function', async () => {
    const mod = await import('./RestartBridgeButton');
    expect(typeof mod.RestartBridgeButton).toBe('function');
  });

  it('opens the confirm dialog explaining the outage', () => {
    render(<RestartBridgeButton />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Перезапустить агент?')).toBeInTheDocument();
    expect(screen.getByText(/~3 секунды/)).toBeInTheDocument();
  });

  it('POSTs to the restart endpoint on confirm and reports the restart', async () => {
    const fetchSpy = mockFetch(new Response('{}'));
    render(<RestartBridgeButton />);
    openDialog();
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(screen.getByText('Агент перезапускается. Ожидание подключения…')).toBeInTheDocument(),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/host/restart',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a permission error on 403', async () => {
    mockFetch(new Response('', { status: 403 }));
    render(<RestartBridgeButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('Нет прав на эту операцию.')).toBeInTheDocument());
  });

  it('shows an agent error on any other non-ok response', async () => {
    mockFetch(new Response('', { status: 500 }));
    render(<RestartBridgeButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(
        screen.getByText('Не удалось дотянуться до агента. Проверьте логи systemd.'),
      ).toBeInTheDocument(),
    );
  });

  it('shows an agent error when fetch throws', async () => {
    mockFetch(() => Promise.reject(new Error('socket hang up')));
    render(<RestartBridgeButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(
        screen.getByText('Не удалось дотянуться до агента. Проверьте логи systemd.'),
      ).toBeInTheDocument(),
    );
  });

  it('closes the dialog via Cancel without calling the API', () => {
    const fetchSpy = mockFetch(new Response('{}'));
    render(<RestartBridgeButton />);
    openDialog();
    const buttons = exits('Отменить');
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('closes the dialog on Escape without calling the API', () => {
    const fetchSpy = mockFetch(new Response('{}'));
    render(<RestartBridgeButton />);
    openDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auto-resets the restarted state to idle after the timeout', async () => {
    vi.useFakeTimers();
    mockFetch(new Response('{}'));
    render(<RestartBridgeButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await vi.waitFor(() =>
      expect(screen.getByText('Агент перезапускается. Ожидание подключения…')).toBeInTheDocument(),
    );
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(
      screen.queryByText('Агент перезапускается. Ожидание подключения…'),
    ).not.toBeInTheDocument();
  });

  it('renders disabled with the reason as the title', () => {
    render(<RestartBridgeButton disabled disabledReason="нет связи" />);
    const btn = screen.getByRole('button', { name: 'Перезапустить агент' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'нет связи');
  });
});
