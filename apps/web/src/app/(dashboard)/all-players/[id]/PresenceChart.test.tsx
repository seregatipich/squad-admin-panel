// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PresenceChart } from './PresenceChart';

function daily(range: number, totalSeconds: number) {
  return {
    range,
    from: '2026-06-01',
    to: '2026-06-30',
    total_time_played_seconds: totalSeconds,
    live: { online: false, since: null },
    series: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PresenceChart — «Наиграно» tile (#454)', () => {
  it('shows a placeholder, not a false zero, while the first request is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(<PresenceChart playerId="player-1" />);

    expect(screen.getByText('Загрузка наигранного времени')).toBeInTheDocument();
    expect(screen.queryByText('0с')).not.toBeInTheDocument();
    expect(screen.queryByText(/0 сек всего/)).not.toBeInTheDocument();
  });

  it('shows a dash instead of zero when the request failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({}, 500))),
    );
    render(<PresenceChart playerId="player-1" />);

    await screen.findByText('Не удалось загрузить онлайн по дням');
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/0 сек всего/)).not.toBeInTheDocument();
  });

  it('shows the played time once it is known', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(daily(30, 7200)))),
    );
    render(<PresenceChart playerId="player-1" />);

    expect(await screen.findByText(/7\s200 сек всего/)).toBeInTheDocument();
  });
});

describe('PresenceChart — retry (#451)', () => {
  it('never lets a retried request for the old range overwrite the selected one', async () => {
    let releaseRetry: (response: Response) => void = () => {};
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls += 1;
        if (url.includes('range=90')) return Promise.resolve(json(daily(90, 9000)));
        if (calls === 1) return Promise.resolve(json({}, 500));
        return new Promise<Response>((resolve) => {
          releaseRetry = resolve;
        });
      }),
    );
    render(<PresenceChart playerId="player-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    fireEvent.click(screen.getByRole('tab', { name: '90 дней' }));
    expect(await screen.findByText(/9\s000 сек всего/)).toBeInTheDocument();

    await act(async () => {
      releaseRetry(json(daily(30, 3000)));
    });

    expect(screen.getByText(/9\s000 сек всего/)).toBeInTheDocument();
    expect(screen.queryByText(/3\s000 сек всего/)).not.toBeInTheDocument();
  });
});
