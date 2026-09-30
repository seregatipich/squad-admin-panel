// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogConsole } from './LogConsole';

afterEach(cleanup);

describe('LogConsole', () => {
  it('shows the empty placeholder while no line has arrived', () => {
    render(<LogConsole lines={[]} emptyText="Ожидание первого сообщения…" />);
    expect(screen.getByText('Ожидание первого сообщения…')).toBeInTheDocument();
  });

  it('renders the title as a heading and the connection state in words', () => {
    const { rerender } = render(
      <LogConsole lines={[]} title="Лог контейнера (docker logs)" live={true} />,
    );
    expect(
      screen.getByRole('heading', { name: 'Лог контейнера (docker logs)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('в эфире')).toBeInTheDocument();

    rerender(<LogConsole lines={[]} title="Лог контейнера (docker logs)" live={false} />);
    expect(screen.getByText('нет связи')).toBeInTheDocument();
  });

  it('marks an stderr line with text, not colour alone', () => {
    render(
      <LogConsole
        lines={[
          { message: 'всё хорошо', stream: 'stdout' },
          { message: 'segmentation fault', stream: 'stderr' },
        ]}
      />,
    );
    expect(screen.getByText('поток ошибок:')).toBeInTheDocument();
    expect(screen.getByText(/segmentation fault/)).toBeInTheDocument();
  });

  it('offers a reconnect action on the connection-error banner', () => {
    const onRetry = vi.fn();
    render(
      <LogConsole
        lines={[]}
        errorBanner={{ code: 1006, reason: 'abnormal closure', retryInMs: 3000, onRetry }}
      />,
    );

    const banner = screen.getByTestId('logconsole-error-banner');
    expect(banner).toHaveTextContent('Соединение разорвано');
    expect(banner).toHaveTextContent('Повтор через 3с…');

    fireEvent.click(screen.getByRole('button', { name: 'Переподключиться' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the reconnect button when the caller supplies no handler', () => {
    render(<LogConsole lines={[]} errorBanner={{ code: null, reason: null }} />);

    expect(screen.getByTestId('logconsole-error-banner')).toHaveTextContent('неизвестный код');
    expect(screen.queryByRole('button', { name: 'Переподключиться' })).not.toBeInTheDocument();
  });

  // #782: once the caller's buffer is capped, every append drops the head and
  // shifts all indices. Index-based keys then remounted every row per line.
  it('keeps existing rows mounted when a capped buffer drops its oldest line', () => {
    const first = { message: 'первая', ts: '2026-01-01T00:00:00Z' };
    const second = { message: 'вторая', ts: '2026-01-01T00:00:00Z' };
    const third = { message: 'третья', ts: '2026-01-01T00:00:00Z' };
    const { rerender } = render(<LogConsole lines={[first, second]} />);
    const before = screen.getByText(/вторая/);

    rerender(<LogConsole lines={[second, third]} />);

    expect(screen.getByText(/вторая/)).toBe(before);
  });

  it('keeps distinct keys for identical lines', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const line = () => ({ message: 'повтор', ts: '2026-01-01T00:00:00Z' });
    render(<LogConsole lines={[line(), line(), line()]} />);
    expect(screen.getAllByText(/повтор/)).toHaveLength(3);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
