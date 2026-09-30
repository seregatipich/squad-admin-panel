// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrimetimeSection } from './PrimetimeSection';

const VALID = {
  window: { from: '2026-06-01', to: '2026-06-30', days: 30 },
  timezone: 'Europe/Moscow',
  offset_minutes: 180,
  total_seconds: 7200,
  histogram: Array.from({ length: 24 }, (_, hour) => (hour === 20 ? 3600 : 60)),
  rolling_average: Array.from({ length: 24 }, () => 0),
  primetime: {
    label: '19:00–23:00',
    start_minutes: 1140,
    end_minutes: 1380,
    start_hour: 19,
    end_hour: 22,
  },
};

function stub(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PrimetimeSection', () => {
  // Regression (#456): a null histogram threw inside Math.max during render.
  it('reports a malformed response instead of crashing', async () => {
    stub({ ...VALID, histogram: null });
    render(<PrimetimeSection playerId="player-1" />);

    expect(await screen.findByText('Не удалось загрузить праймтайм')).toBeInTheDocument();
  });

  // Regression (#458): each hour was a focusable <button> with no action.
  it('draws the 24 hours as labelled images, not as action-less buttons', async () => {
    stub(VALID);
    render(<PrimetimeSection playerId="player-1" />);

    await screen.findByText('19:00–23:00');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    const hours = screen.getAllByRole('img');
    expect(hours).toHaveLength(24);
    expect(hours[20]).toHaveAccessibleName('20:00 — 1ч 0м');
  });

  it('shows the hovered hour in the caption', async () => {
    stub(VALID);
    render(<PrimetimeSection playerId="player-1" />);

    const hours = await screen.findAllByRole('img');
    fireEvent.pointerEnter(hours[20] as HTMLElement);
    expect(screen.getByText('1ч 0м')).toBeInTheDocument();
  });
});
