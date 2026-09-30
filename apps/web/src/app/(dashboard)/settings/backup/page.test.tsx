// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/BackupTriggerButton', () => ({
  BackupTriggerButton: (props: { disabled?: boolean; onBackedUp?: () => void }) => (
    <button
      type="button"
      data-disabled={props.disabled ? 'true' : 'false'}
      onClick={() => props.onBackedUp?.()}
    >
      trigger
    </button>
  ),
}));
vi.mock('@/components/RestoreSnapshotButton', () => ({
  RestoreSnapshotButton: (props: { shortId: string; onRestored?: () => void }) => (
    <button type="button" onClick={() => props.onRestored?.()}>
      restore-{props.shortId}
    </button>
  ),
}));

import BackupPage from './page';

const POLL_MS = 30_000;

function mockFetchOnce(response: Response | (() => Promise<Response>)) {
  const fn = typeof response === 'function' ? response : () => Promise.resolve(response);
  const spy = vi.fn(fn);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function snapshotList(snapshots: unknown[]) {
  return new Response(JSON.stringify({ snapshots }), { status: 200 });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BackupPage', () => {
  it('renders the snapshot table with a restore control per row', async () => {
    mockFetchOnce(
      snapshotList([
        {
          id: 'full-1',
          short_id: 'a1b2c3d4',
          time: '2026-07-24T03:00:00Z',
          hostname: 'stand-host',
          paths: ['/data'],
          tags: ['cron'],
        },
      ]),
    );
    render(<BackupPage />);
    await waitFor(() => expect(screen.getByText('a1b2c3d4')).toBeInTheDocument());
    expect(screen.getByText('stand-host')).toBeInTheDocument();
    expect(screen.getByText('cron')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'restore-a1b2c3d4' })).toBeInTheDocument();
  });

  it('renders an empty-state row when there are no snapshots', async () => {
    mockFetchOnce(snapshotList([]));
    render(<BackupPage />);
    await waitFor(() => expect(screen.getByText(/Снимков пока нет/)).toBeInTheDocument());
  });

  it('renders a dash for a snapshot with no tags and passes the raw time when unparseable', async () => {
    mockFetchOnce(
      snapshotList([
        {
          id: 'full-2',
          short_id: 'deadbeef',
          time: 'not-a-date',
          hostname: 'stand-host',
          paths: ['/data'],
          tags: [],
        },
      ]),
    );
    render(<BackupPage />);
    await waitFor(() => expect(screen.getByText('deadbeef')).toBeInTheDocument());
    // Invalid date string is passed through verbatim by formatDate.
    expect(screen.getByText('not-a-date')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the forbidden banner on 403 and disables the trigger', async () => {
    mockFetchOnce(new Response('', { status: 403 }));
    render(<BackupPage />);
    await waitFor(() => expect(screen.getByText(/Недостаточно прав/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'trigger' })).toHaveAttribute(
      'data-disabled',
      'true',
    );
  });

  it('shows the API detail on a non-ok, non-403 response', async () => {
    mockFetchOnce(new Response(JSON.stringify({ detail: 'bridge down' }), { status: 502 }));
    render(<BackupPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/Не удалось загрузить список бэкапов: bridge down/),
      ).toBeInTheDocument(),
    );
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    mockFetchOnce(new Response('nope', { status: 500 }));
    render(<BackupPage />);
    await waitFor(() =>
      expect(screen.getByText(/Не удалось загрузить список бэкапов: HTTP 500/)).toBeInTheDocument(),
    );
  });

  it('shows a transport error when fetch throws', async () => {
    mockFetchOnce(() => Promise.reject(new Error('offline')));
    render(<BackupPage />);
    await waitFor(() =>
      expect(screen.getByText(/Не удалось загрузить список бэкапов: offline/)).toBeInTheDocument(),
    );
  });

  it('re-fetches the snapshot list after a backup or a restore completes', async () => {
    const snapshot = {
      id: 'full-3',
      short_id: 'a1b2c3d4',
      time: '2026-07-24T03:00:00Z',
      hostname: 'stand-host',
      paths: ['/data'],
      tags: [],
    };
    const fetchSpy = mockFetchOnce(() => Promise.resolve(snapshotList([snapshot])));
    render(<BackupPage />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'restore-a1b2c3d4' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
  });

  it('offers a retry on the error banner and reloads the list', async () => {
    let failing = true;
    const fetchSpy = mockFetchOnce(() =>
      failing
        ? Promise.resolve(new Response(JSON.stringify({ detail: 'bridge down' }), { status: 502 }))
        : Promise.resolve(
            snapshotList([
              {
                id: 'full-4',
                short_id: 'cafebabe',
                time: '2026-07-24T03:00:00Z',
                hostname: 'stand-host',
                paths: ['/data'],
                tags: [],
              },
            ]),
          ),
    );
    render(<BackupPage />);
    await waitFor(() =>
      expect(screen.getByText(/Не удалось загрузить список бэкапов/)).toBeInTheDocument(),
    );

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    await waitFor(() => expect(screen.getByText('cafebabe')).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Не удалось загрузить список бэкапов/)).not.toBeInTheDocument();
  });

  it('polls the snapshot list on the interval', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = mockFetchOnce(() => Promise.resolve(snapshotList([])));
      render(<BackupPage />);
      // Wait for the *first* load to fully settle (not just be invoked) before
      // advancing the clock — the in-flight overlap guard (#675) would
      // otherwise see the first load still "in progress" and skip the tick.
      await vi.waitFor(() => expect(screen.getByText('Снимков пока нет')).toBeInTheDocument());
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a snapshot whose tags are null or absent without crashing (#674)', async () => {
    mockFetchOnce(
      snapshotList([
        {
          id: 'a',
          short_id: 'nulltags1',
          time: '2026-01-01T00:00:00Z',
          hostname: 'h',
          paths: [],
          tags: null,
        },
        { id: 'b', short_id: 'notags22', time: '2026-01-01T00:00:00Z', hostname: 'h', paths: [] },
      ]),
    );
    render(<BackupPage />);
    await waitFor(() => expect(screen.getByText('nulltags1')).toBeInTheDocument());
    expect(screen.getByText('notags22')).toBeInTheDocument();
  });

  it('does not poll while the tab is hidden (#675)', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      const fetchSpy = mockFetchOnce(() => Promise.resolve(snapshotList([])));
      render(<BackupPage />);
      await vi.waitFor(() => expect(screen.getByText('Снимков пока нет')).toBeInTheDocument());
      act(() => {
        vi.advanceTimersByTime(POLL_MS * 3);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops polling after a 403 (#675)', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = mockFetchOnce(() => Promise.resolve(new Response('', { status: 403 })));
      render(<BackupPage />);
      await vi.waitFor(() => expect(screen.getByText('Недостаточно прав')).toBeInTheDocument());
      act(() => {
        vi.advanceTimersByTime(POLL_MS * 3);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last good list when a background refresh fails (#675)', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchSpy = mockFetchOnce(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(
              snapshotList([
                {
                  id: 'k',
                  short_id: 'keepme12',
                  time: '2026-01-01T00:00:00Z',
                  hostname: 'h',
                  paths: [],
                  tags: [],
                },
              ]),
            )
          : Promise.reject(new Error('boom'));
      });
      render(<BackupPage />);
      await vi.waitFor(() => expect(screen.getByText('keepme12')).toBeInTheDocument());
      act(() => {
        vi.advanceTimersByTime(POLL_MS);
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('keepme12')).toBeInTheDocument();
      expect(screen.queryByText(/Не удалось загрузить список бэкапов/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
