// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

// Isolate the banner from the live-bus WebSocket machinery.
vi.mock('@/lib/live-bus', () => ({
  getLiveBus: () => ({ retain: () => () => {} }),
}));

import { ConnectionBanner } from './connection-banner';

const PROBE_INTERVAL_MS = 30_000;

beforeEach(() => {
  vi.useFakeTimers();
  // Every /api/v1/me probe fails, driving the banner past its failure threshold.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Advances past enough failed probes to make the banner visible. */
async function driveToUnreachable(): Promise<void> {
  // Two failed probes (FAIL_THRESHOLD) flip the banner to visible. Each timer
  // advance also flushes the probe promise + resulting React state update.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
  });
}

describe('ConnectionBanner', () => {
  it('is hidden until the panel is confirmed unreachable', () => {
    render(
      <LocaleProvider locale="ru">
        <ConnectionBanner />
      </LocaleProvider>,
    );
    expect(screen.queryByTestId('connection-banner')).not.toBeInTheDocument();
  });

  it('shows the unavailable toast in Russian', async () => {
    render(
      <LocaleProvider locale="ru">
        <ConnectionBanner />
      </LocaleProvider>,
    );
    await driveToUnreachable();
    expect(screen.getByText('Панель временно недоступна.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скрыть' })).toBeInTheDocument();
  });
});
