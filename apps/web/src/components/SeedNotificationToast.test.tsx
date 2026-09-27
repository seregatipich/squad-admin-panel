// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { SeedNotificationToast } from './SeedNotificationToast';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

type AlertTriggeredEvent = Extract<LiveEvent, { type: 'alert.triggered' }>;

let alertHandler: ((event: AlertTriggeredEvent) => void) | undefined;

beforeEach(() => {
  vi.mocked(useLiveSubscription).mockImplementation((_type, handler) => {
    alertHandler = handler as (event: AlertTriggeredEvent) => void;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  alertHandler = undefined;
});

describe('SeedNotificationToast', () => {
  it('shows a delivered seed alert with a working Steam join link', () => {
    render(<SeedNotificationToast />);

    act(() => {
      alertHandler?.({
        type: 'alert.triggered',
        ts: '2026-07-14T12:00:00.000Z',
        data: {
          event_kind: 'seed.call_sent',
          channel: 'webpush',
          message: 'Нужен сид',
          server_name: 'RU #1',
          join_link: 'steam://connect/203.0.113.10:7787',
        },
      });
    });

    expect(screen.getByRole('status')).toHaveTextContent('Нужен сид');
    expect(screen.getByRole('status')).toHaveTextContent('RU #1');
    expect(screen.getByRole('link', { name: 'Подключиться' })).toHaveAttribute(
      'href',
      'steam://connect/203.0.113.10:7787',
    );
  });

  it('ignores non-webpush alerts and can dismiss a seed alert', () => {
    render(<SeedNotificationToast />);

    const event: AlertTriggeredEvent = {
      type: 'alert.triggered',
      ts: '2026-07-14T12:00:00.000Z',
      data: {
        event_kind: 'seed.call_sent',
        channel: 'email',
        server_name: 'RU #1',
        join_link: 'steam://connect/203.0.113.10:7787',
      },
    };
    act(() => alertHandler?.(event));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => alertHandler?.({ ...event, data: { ...event.data, channel: 'webpush' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть уведомление' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
