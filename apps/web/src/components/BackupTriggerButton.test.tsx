// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupTriggerButton } from './BackupTriggerButton';

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

/** Триггер в строке — единственная кнопка «Создать бэкап» до открытия окна. */
function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Создать бэкап' }));
}

/** Подтверждающая кнопка окна; называется так же, как триггер, — берём внутри диалога. */
function confirmButton() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Создать бэкап' });
}

/** Крестик и «Отменить» — один и тот же выход, поэтому и подпись у них одна. */
function cancelButtons(name: string) {
  return within(screen.getByRole('dialog')).getAllByRole('button', { name });
}

describe('BackupTriggerButton', () => {
  it('opens the confirm dialog when the trigger is clicked', () => {
    render(<BackupTriggerButton />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Создать бэкап?')).toBeInTheDocument();
  });

  it('POSTs to the backups endpoint on confirm and shows the done state', async () => {
    const fetchSpy = mockFetch(new Response(JSON.stringify({ ok: true, exit_code: 0 })));
    const onBackedUp = vi.fn();
    render(<BackupTriggerButton onBackedUp={onBackedUp} />);
    openDialog();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onBackedUp).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/host/backups',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByText('Бэкап создан')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a permission error on 403', async () => {
    mockFetch(new Response('', { status: 403 }));
    render(<BackupTriggerButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('Нет прав на эту операцию.')).toBeInTheDocument());
  });

  it('surfaces the API detail on a non-ok, non-403 response', async () => {
    mockFetch(new Response(JSON.stringify({ detail: 'compose blew up' }), { status: 502 }));
    render(<BackupTriggerButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByText('Не удалось создать бэкап: compose blew up')).toBeInTheDocument(),
    );
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    mockFetch(new Response('not json', { status: 500 }));
    render(<BackupTriggerButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByText('Не удалось создать бэкап: HTTP 500')).toBeInTheDocument(),
    );
  });

  it('shows a transport error when fetch throws', async () => {
    mockFetch(() => Promise.reject(new Error('socket hang up')));
    render(<BackupTriggerButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(
        screen.getByText('Не удалось дотянуться до агента: socket hang up'),
      ).toBeInTheDocument(),
    );
  });

  it('closes the dialog via Cancel without calling the API', () => {
    const fetchSpy = mockFetch(new Response('{}'));
    render(<BackupTriggerButton />);
    openDialog();
    const exits = cancelButtons('Отменить');
    fireEvent.click(exits[exits.length - 1] as HTMLElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('closes the dialog on Escape without calling the API', () => {
    const fetchSpy = mockFetch(new Response('{}'));
    render(<BackupTriggerButton />);
    openDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('closes the error dialog via the Закрыть button', async () => {
    mockFetch(new Response('', { status: 403 }));
    render(<BackupTriggerButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('Нет прав на эту операцию.')).toBeInTheDocument());
    const exits = cancelButtons('Закрыть');
    fireEvent.click(exits[exits.length - 1] as HTMLElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('auto-resets the done state to idle after the timeout', async () => {
    vi.useFakeTimers();
    mockFetch(new Response(JSON.stringify({ ok: true })));
    render(<BackupTriggerButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(screen.getByText('Бэкап создан')).toBeInTheDocument());
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.queryByText('Бэкап создан')).not.toBeInTheDocument();
  });

  it('renders disabled with the reason as the title', () => {
    render(<BackupTriggerButton disabled disabledReason="нет прав" />);
    const btn = screen.getByRole('button', { name: 'Создать бэкап' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'нет прав');
  });
});
