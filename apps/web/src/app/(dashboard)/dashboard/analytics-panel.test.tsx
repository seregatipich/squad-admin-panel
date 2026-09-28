// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsPanel } from './analytics-panel';

describe('AnalyticsPanel', () => {
  it('is a valid React component', () => {
    expect(AnalyticsPanel).toBeDefined();
    expect(typeof AnalyticsPanel).toBe('function');
  });
});

function analyticsBody(totalMatches: number) {
  return {
    summary: {
      total_matches: totalMatches,
      total_online_hours: 1,
      unique_players: 1,
      avg_match_duration_seconds: 60,
    },
    peak_by_hour: [],
    match_outcomes: { total: 0, team1: 0, team2: 0, draw: 0, unknown: 0 },
    popular_maps: [],
    popular_layers: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AnalyticsPanel — ANALYTICS-538 out-of-order responses', () => {
  it('keeps the data for the latest request even when an earlier, slower request resolves last', async () => {
    const servers = [
      { id: 'srv-1', display_name: 'Server A' },
      { id: 'srv-2', display_name: 'Server B' },
    ];
    const deferreds: Array<{ resolve: (body: unknown) => void }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        return new Promise((resolve) => {
          deferreds.push({
            resolve: (body: unknown) =>
              resolve(new Response(JSON.stringify(body), { status: 200 })),
          });
        });
      }),
    );

    render(<AnalyticsPanel servers={servers} />);

    // Wait for the initial (all-servers) request to be issued.
    await vi.waitFor(() => expect(deferreds.length).toBe(1));

    // Switch server: a second request starts before the first resolves.
    fireEvent.change(screen.getByLabelText('Сервер'), { target: { value: 'srv-1' } });
    await vi.waitFor(() => expect(deferreds.length).toBe(2));

    // The second (latest) request resolves first, the first (now-stale) request
    // resolves after it — a classic out-of-order race.
    deferreds[1]?.resolve(analyticsBody(222));
    await screen.findByText('222');
    deferreds[0]?.resolve(analyticsBody(111));

    // The stale response must never overwrite the latest one.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    expect(screen.getByText('222')).toBeInTheDocument();
  });
});
