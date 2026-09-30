// @vitest-environment happy-dom
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
      <LocaleProvider>
        <ConnectionBanner />
      </LocaleProvider>,
    );
    expect(screen.queryByTestId('connection-banner')).not.toBeInTheDocument();
  });

  it('shows the unavailable toast in Russian', async () => {
    render(
      <LocaleProvider>
        <ConnectionBanner />
      </LocaleProvider>,
    );
    await driveToUnreachable();
    expect(screen.getByText('Панель временно недоступна.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скрыть' })).toBeInTheDocument();
  });

  it('sends the tab to the login page on 401 instead of reporting the panel unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 }))),
    );
    const location = { href: '' };
    vi.stubGlobal('location', location);
    render(
      <LocaleProvider>
        <ConnectionBanner />
      </LocaleProvider>,
    );
    await driveToUnreachable();

    expect(location.href).toBe('/login');
    expect(screen.queryByTestId('connection-banner')).not.toBeInTheDocument();
  });

  it('stops probing once unmounted while a probe is in flight', async () => {
    let finishProbe: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishProbe = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(
      <LocaleProvider>
        <ConnectionBanner />
      </LocaleProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      finishProbe(new Response('{}', { status: 200 }));
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
