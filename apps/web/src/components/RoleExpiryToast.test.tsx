// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { RoleExpiryToast } from './RoleExpiryToast';

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

function roleExpiringEvent(): AlertTriggeredEvent {
  return {
    type: 'alert.triggered',
    ts: '2026-07-20T12:00:00.000Z',
    data: {
      event_kind: 'role_expiring',
      player_id: '019e0000-0000-7000-8000-000000000301',
      player_name: 'VipPlayer',
      role_id: '019e0000-0000-7000-8000-000000000401',
      role_name: 'VIP',
      expires_at: '2026-07-23T12:00:00.000Z',
      window_days: 3,
    },
  };
}

describe('RoleExpiryToast', () => {
  it('shows a toast for role_expiring frames', () => {
    render(<RoleExpiryToast />);

    act(() => alertHandler?.(roleExpiringEvent()));

    expect(screen.getByRole('status')).toHaveTextContent('VIP истекает через 3 дн.');
    expect(screen.getByRole('status')).toHaveTextContent('VipPlayer — VIP');

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть уведомление об истечении VIP' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('ignores other event kinds', () => {
    render(<RoleExpiryToast />);

    const event = roleExpiringEvent();
    act(() => alertHandler?.({ ...event, data: { ...event.data, event_kind: 'seed.call_sent' } }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => alertHandler?.({ ...event, data: { ...event.data, player_name: '' } }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
