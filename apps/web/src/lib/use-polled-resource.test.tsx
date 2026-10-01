// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { useApiResource, usePolledResource } from './use-polled-resource';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fetcher whose every call stays pending until the test settles it. */
function controlledFetcher<T>() {
  const calls: { signal: AbortSignal; settle: Deferred<T> }[] = [];
  const fetcher = vi.fn((signal: AbortSignal) => {
    const settle = deferred<T>();
    calls.push({ signal, settle });
    return settle.promise;
  });
  return { fetcher, calls };
}

function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'hidden');
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('usePolledResource: loading', () => {
  it('fetches on mount: loading first, then the data', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    const { result } = renderHook(() => usePolledResource('k', fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => calls[0]?.settle.resolve('hello'));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('hello');
    expect(result.current.error).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it('is a one-shot without intervalMs: no timer, no second fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue('v');
    renderHook(() => usePolledResource('k', fetcher));
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stays idle for a null key and for enabled: false', async () => {
    const fetcher = vi.fn().mockResolvedValue('v');
    const { result, rerender } = renderHook(
      ({ k, enabled }: { k: string | null; enabled: boolean }) =>
        usePolledResource(k, fetcher, { intervalMs: 1000, enabled }),
      { initialProps: { k: null as string | null, enabled: true } },
    );
    expect(result.current.loading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    rerender({ k: 'k', enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await act(() => result.current.refresh());
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ k: 'k', enabled: true });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('v');
  });

  it('always runs the latest fetcher closure without refetching on re-render', async () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ tag }: { tag: string }) =>
        usePolledResource(
          'k',
          async () => {
            seen.push(tag);
            return tag;
          },
          { intervalMs: 1000 },
        ),
      { initialProps: { tag: 'a' } },
    );
    await flush();
    rerender({ tag: 'b' });
    expect(seen).toEqual(['a']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('usePolledResource: errors', () => {
  it('reports a failure, keeps the last data and clears the error on recovery', async () => {
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new ApiError('/api/v1/x', 503, 'down'))
      .mockResolvedValueOnce('second');
    const { result } = renderHook(() => usePolledResource('k', fetcher, { intervalMs: 1000 }));
    await flush();
    expect(result.current.data).toBe('first');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.data).toBe('first');
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.errorMessage).toBe('HTTP 503');
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.data).toBe('second');
    expect(result.current.error).toBeNull();
  });

  it('settles loading when the very first fetch fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => usePolledResource('k', fetcher));
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.errorMessage).toBe('Failed to fetch');
  });

  it('wraps a non-Error rejection in an Error', async () => {
    const fetcher = vi.fn().mockRejectedValue('plain text');
    const { result } = renderHook(() => usePolledResource('k', fetcher));
    await flush();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.errorMessage).toBe('plain text');
  });

  it('refresh never rejects, even when the fetch fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => usePolledResource('k', fetcher));
    await flush();
    await expect(act(() => result.current.refresh())).resolves.toBeUndefined();
    expect(result.current.errorMessage).toBe('nope');
  });
});

describe('usePolledResource: polling', () => {
  it('refetches every interval and clears the timer on unmount', async () => {
    const fetcher = vi.fn().mockResolvedValue('v');
    const { unmount } = renderHook(() => usePolledResource('k', fetcher, { intervalMs: 1000 }));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(4);

    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('skips a tick while the previous request is still in flight', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    renderHook(() => usePolledResource('k', fetcher, { intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(calls[0]?.signal.aborted).toBe(false);

    await act(async () => calls[0]?.settle.resolve('v'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('restarts the timer when the interval changes and drops it when it is removed', async () => {
    const fetcher = vi.fn().mockResolvedValue('v');
    const { rerender } = renderHook(
      ({ ms }: { ms: number | undefined }) =>
        usePolledResource('k', fetcher, ms === undefined ? {} : { intervalMs: ms }),
      { initialProps: { ms: 1000 as number | undefined } },
    );
    await flush();
    rerender({ ms: 5000 });
    await flush();
    const afterRerender = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(fetcher).toHaveBeenCalledTimes(afterRerender);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(afterRerender + 1);

    rerender({ ms: undefined });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops polling once stopPolling matches, but refresh still fetches and re-arms it', async () => {
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new ApiError('/api/v1/x', 404, ''))
      .mockResolvedValueOnce('back')
      .mockResolvedValue('again');
    const { result } = renderHook(() =>
      usePolledResource('k', fetcher, {
        intervalMs: 1000,
        stopPolling: (e) => e instanceof ApiError && e.status === 404,
      }),
    );
    await flush();
    expect(result.current.errorMessage).toBe('HTTP 404');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(() => result.current.refresh());
    expect(result.current.data).toBe('back');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('usePolledResource: hidden tab', () => {
  it('polls through a hidden tab by default', async () => {
    setTabHidden(true);
    const fetcher = vi.fn().mockResolvedValue('v');
    renderHook(() => usePolledResource('k', fetcher, { intervalMs: 1000 }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('with pauseWhenHidden skips ticks while hidden and refetches when the tab returns', async () => {
    setTabHidden(false);
    const fetcher = vi.fn().mockResolvedValue('v');
    const { unmount } = renderHook(() =>
      usePolledResource('k', fetcher, { intervalMs: 1000, pauseWhenHidden: true }),
    );
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    setTabHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    setTabHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const removeListener = vi.spyOn(document, 'removeEventListener');
    unmount();
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('still fetches on mount and on refresh while hidden', async () => {
    setTabHidden(true);
    const fetcher = vi.fn().mockResolvedValue('v');
    const { result } = renderHook(() =>
      usePolledResource('k', fetcher, { intervalMs: 1000, pauseWhenHidden: true }),
    );
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(() => result.current.refresh());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('usePolledResource: aborting', () => {
  it('aborts the in-flight request on unmount and never applies its late answer', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => usePolledResource('k', fetcher));
    expect(calls[0]?.signal.aborted).toBe(false);

    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
    await act(async () => calls[0]?.settle.resolve('late'));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('ignores the abort rejection that unmounting causes', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    const { result, unmount } = renderHook(() => usePolledResource('k', fetcher));
    unmount();
    await act(async () =>
      calls[0]?.settle.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    expect(result.current.error).toBeNull();
  });

  it('refresh aborts the request in flight; only the newest answer lands', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    const { result } = renderHook(() => usePolledResource('k', fetcher));

    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh();
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);

    await act(async () => {
      calls[1]?.settle.resolve('new');
      await refreshed;
    });
    await act(async () => calls[0]?.settle.resolve('old'));
    expect(result.current.data).toBe('new');
  });

  it('drops an aborted request that failed after being superseded', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    const { result } = renderHook(() => usePolledResource('k', fetcher));
    act(() => {
      void result.current.refresh();
    });
    await act(async () => calls[0]?.settle.reject(new Error('stale failure')));
    expect(result.current.error).toBeNull();
    await act(async () => calls[1]?.settle.resolve('ok'));
    expect(result.current.data).toBe('ok');
  });
});

describe('usePolledResource: key changes', () => {
  it('refetches for a new key, aborts the old request and never shows the old data', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => usePolledResource(k, fetcher),
      {
        initialProps: { k: 'a' },
      },
    );
    await act(async () => calls[0]?.settle.resolve('data-a'));
    expect(result.current.data).toBe('data-a');

    rerender({ k: 'b' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => calls[1]?.settle.resolve('data-b'));
    expect(result.current.data).toBe('data-b');
    expect(result.current.loading).toBe(false);
  });

  it('does not let a slow answer for the old key overwrite the new key', async () => {
    const { fetcher, calls } = controlledFetcher<string>();
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => usePolledResource(k, fetcher),
      {
        initialProps: { k: 'a' },
      },
    );
    rerender({ k: 'b' });
    expect(calls[0]?.signal.aborted).toBe(true);
    await act(async () => calls[1]?.settle.resolve('data-b'));
    await act(async () => calls[0]?.settle.resolve('data-a'));
    expect(result.current.data).toBe('data-b');
  });

  it('does not carry the old key error or data into a failing new key', async () => {
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce('data-a')
      .mockRejectedValueOnce(new Error('b failed'));
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => usePolledResource(k, fetcher),
      {
        initialProps: { k: 'a' },
      },
    );
    await flush();
    rerender({ k: 'b' });
    await flush();
    expect(result.current.data).toBeUndefined();
    expect(result.current.errorMessage).toBe('b failed');
  });
});

describe('usePolledResource: setData', () => {
  it('applies a value or an updater locally and is overwritten by the next fetch', async () => {
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<{ n: number }>>()
      .mockResolvedValueOnce({ n: 1 })
      .mockResolvedValueOnce({ n: 10 });
    const { result } = renderHook(() => usePolledResource('k', fetcher));
    await flush();

    act(() => result.current.setData((prev) => (prev ? { n: prev.n + 1 } : prev)));
    expect(result.current.data).toEqual({ n: 2 });

    act(() => result.current.setData({ n: 5 }));
    expect(result.current.data).toEqual({ n: 5 });

    await act(() => result.current.refresh());
    expect(result.current.data).toEqual({ n: 10 });
  });

  it('hands the updater undefined before the first answer', () => {
    const { fetcher } = controlledFetcher<string>();
    const { result } = renderHook(() => usePolledResource('k', fetcher));
    const updater = vi.fn((prev: string | undefined) => prev);
    act(() => result.current.setData(updater));
    expect(updater).toHaveBeenCalledWith(undefined);
  });
});

describe('useApiResource', () => {
  it('GETs the path with credentials and no-store and exposes the JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(Response.json({ items: [1, 2] }));
    vi.stubGlobal('fetch', mockFetch);
    const { result } = renderHook(() => useApiResource<{ items: number[] }>('/api/v1/servers'));
    await flush();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/servers',
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.current.data).toEqual({ items: [1, 2] });
  });

  it('turns a non-2xx answer into an HTTP <status> message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 403 })));
    const { result } = renderHook(() => useApiResource('/api/v1/servers'));
    await flush();
    expect(result.current.errorMessage).toBe('HTTP 403');
  });

  it('polls on the interval and stays idle for a null path', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal('fetch', mockFetch);
    const { rerender } = renderHook(
      ({ path }: { path: string | null }) => useApiResource(path, { intervalMs: 1000 }),
      { initialProps: { path: null as string | null } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    rerender({ path: '/api/v1/x' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
