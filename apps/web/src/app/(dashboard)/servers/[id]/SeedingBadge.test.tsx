// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import { SeedingBadge } from './SeedingBadge';

afterEach(() => {
  cleanup();
});

describe('SeedingBadge', () => {
  it('renders nothing when there is no initial seeding data (unknown)', () => {
    const { container } = render(<SeedingBadge serverId="srv-1" initial={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the state is "live"', () => {
    const { container } = render(
      <SeedingBadge
        serverId="srv-1"
        initial={{
          state: 'live',
          current_players: 80,
          live_at: 60,
          progress_pct: 100,
          started_at: null,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the "Сидинг" badge and progress label when seeding', () => {
    render(
      <SeedingBadge
        serverId="srv-1"
        initial={{
          state: 'seeding',
          current_players: 40,
          live_at: 60,
          progress_pct: 66,
          started_at: '2026-07-14T09:00:00.000Z',
        }}
      />,
    );
    expect(screen.getByText('Сидинг')).toBeInTheDocument();
    expect(screen.getByText('40 / 60 игроков до live')).toBeInTheDocument();
  });

  it('renders a progress bar whose value matches progress_pct', () => {
    render(
      <SeedingBadge
        serverId="srv-1"
        initial={{
          state: 'seeding',
          current_players: 45,
          live_at: 60,
          progress_pct: 75,
          started_at: '2026-07-14T09:00:00.000Z',
        }}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Прогресс сидинга' });
    expect(bar).toHaveAttribute('aria-valuenow', '75');
    expect(bar).toHaveAttribute('aria-valuetext', '45 / 60 игроков до live');
  });

  it('clamps progress_pct above 100 to a full bar', () => {
    render(
      <SeedingBadge
        serverId="srv-1"
        initial={{
          state: 'seeding',
          current_players: 120,
          live_at: 60,
          progress_pct: 150,
          started_at: '2026-07-14T09:00:00.000Z',
        }}
      />,
    );
    expect(screen.getByRole('progressbar', { name: 'Прогресс сидинга' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });
});
