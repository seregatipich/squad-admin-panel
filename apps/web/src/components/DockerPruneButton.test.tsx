// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerPruneButton } from './DockerPruneButton';

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
  fireEvent.click(screen.getByRole('button', { name: 'Очистить docker' }));
}

/** Подтверждающая кнопка называется так же, как триггер, — берём её внутри окна. */
function confirmButton() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Очистить docker' });
}

/** Крестик и кнопка отказа делят одну подпись — это один и тот же выход. */
function exits(name: string) {
  return within(screen.getByRole('dialog')).getAllByRole('button', { name });
}

describe('DockerPruneButton', () => {
  it('exports a React component function', async () => {
    const mod = await import('./DockerPruneButton');
    expect(typeof mod.DockerPruneButton).toBe('function');
  });

  it('opens the confirm dialog naming what will be deleted', () => {
    render(<DockerPruneButton />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Очистить docker?')).toBeInTheDocument();
    expect(screen.getByText(/Volumes/)).toBeInTheDocument();
  });

  it('POSTs to the prune endpoint on confirm and reports the reclaimed size', async () => {
    const fetchSpy = mockFetch(new Response(JSON.stringify({ reclaimed_human: '1.2GB' })));
    const onCleaned = vi.fn();
    render(<DockerPruneButton onCleaned={onCleaned} />);
    openDialog();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onCleaned).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/host/docker-prune',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByText('Освобождено: 1.2GB')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a permission error on 403', async () => {
    mockFetch(new Response('', { status: 403 }));
    render(<DockerPruneButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('Нет прав на эту операцию.')).toBeInTheDocument());
  });

  it('surfaces the API detail on a non-ok, non-403 response', async () => {
    mockFetch(new Response(JSON.stringify({ detail: 'daemon busy' }), { status: 502 }));
    render(<DockerPruneButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByText('Не удалось очистить: daemon busy')).toBeInTheDocument(),
    );
  });

  it('shows a transport error when fetch throws', async () => {
    mockFetch(() => Promise.reject(new Error('socket hang up')));
    render(<DockerPruneButton />);
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
    render(<DockerPruneButton />);
    openDialog();
    const buttons = exits('Отменить');
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('closes the dialog on Escape without calling the API', () => {
    const fetchSpy = mockFetch(new Response('{}'));
    render(<DockerPruneButton />);
    openDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auto-resets the done state to idle after the timeout', async () => {
    vi.useFakeTimers();
    mockFetch(new Response(JSON.stringify({ reclaimed_human: '0B' })));
    render(<DockerPruneButton />);
    openDialog();
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(screen.getByText('Освобождено: 0B')).toBeInTheDocument());
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.queryByText('Освобождено: 0B')).not.toBeInTheDocument();
  });

  it('renders disabled with the reason as the title', () => {
    render(<DockerPruneButton disabled disabledReason="нет связи" />);
    const btn = screen.getByRole('button', { name: 'Очистить docker' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'нет связи');
  });
});
