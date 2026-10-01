import { type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, describeHttpError } from './api';

export interface PolledResourceOptions {
  /** Poll period in milliseconds. Omitted: the resource is fetched once per key. */
  intervalMs?: number;
  /**
   * `false` keeps the resource idle: no request and no timer, until it flips
   * back to `true`. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Skip poll ticks while the tab is hidden and refetch as soon as it is
   * visible again. The mount fetch and explicit `refresh()` calls always run.
   * Defaults to `false`.
   */
  pauseWhenHidden?: boolean;
  /**
   * Called with every fetch error; returning `true` stops the poll (a failure
   * that every later tick would repeat, such as a 404). A later `refresh()`
   * still fetches, and a successful fetch re-arms the poll.
   */
  stopPolling?: (error: unknown) => boolean;
}

export interface PolledResource<T> {
  /** Latest successful result; it survives a failed refetch and resets when `key` changes. */
  data: T | undefined;
  /** Error of the latest fetch, `null` once a later fetch succeeds. */
  error: Error | null;
  /** `describeHttpError` of `error`, ready for an error strip. */
  errorMessage: string | null;
  /** `true` until the first fetch for the current key settles (success or failure). */
  loading: boolean;
  /**
   * Fetches now, aborting a request that is still in flight, unless
   * `skipIfInFlight` is set: then a pending request is left alone and the call
   * does nothing (for a nudge that fires faster than the API answers, where
   * replacing the request each time would starve it). Never rejects: failures
   * land in `error`. Resolves once the request settled or was superseded.
   */
  refresh: (options?: { skipIfInFlight?: boolean }) => Promise<void>;
  /** Replaces `data` locally, e.g. to apply a live-bus push; the next fetch overwrites it. */
  setData: (next: SetStateAction<T | undefined>) => void;
}

interface State<T> {
  key: string | null;
  data: T | undefined;
  error: Error | null;
  settled: boolean;
}

/**
 * Upper bound for one `useApiResource` request. Poll ticks never overlap an
 * in-flight request, so a request that hangs forever would stall the poll for
 * good; the bound is generous enough not to cut off a slow bridge-backed read.
 */
const RESOURCE_TIMEOUT_MS = 30_000;

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

function isTabHidden(): boolean {
  return document.hidden || document.visibilityState === 'hidden';
}

/**
 * Loads a resource on mount, optionally keeps it fresh on an interval, and
 * owns everything that makes hand-rolled `useEffect` polling leak: the timer
 * is cleared and the in-flight request aborted on unmount, on a `key` change
 * and on every explicit refetch, and a response that lost the race never
 * reaches state.
 *
 * A poll tick never overlaps a request that is still in flight (a slow
 * response must not pile up behind the next tick); an explicit `refresh()`
 * replaces it.
 *
 * @param key Identity of the resource. A change refetches and drops the data
 *   of the previous key; `null` keeps the hook idle.
 * @param fetcher Loads the resource. It must honour `signal`. The latest
 *   function is always used, so it may close over fresh props and state
 *   without being memoised.
 * @param options See {@link PolledResourceOptions}.
 */
export function usePolledResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: PolledResourceOptions = {},
): PolledResource<T> {
  const { intervalMs, enabled = true, pauseWhenHidden = false, stopPolling } = options;
  const active = enabled && key !== null;

  const [state, setState] = useState<State<T>>({
    key,
    data: undefined,
    error: null,
    settled: false,
  });
  const fetcherRef = useRef(fetcher);
  const stopPollingRef = useRef(stopPolling);
  useEffect(() => {
    fetcherRef.current = fetcher;
    stopPollingRef.current = stopPolling;
  });
  const inFlight = useRef<AbortController | null>(null);
  const stopped = useRef(false);

  const run = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const value = await fetcherRef.current(controller.signal);
      if (controller.signal.aborted) return;
      stopped.current = false;
      setState({ key, data: value, error: null, settled: true });
    } catch (thrown) {
      if (controller.signal.aborted) return;
      if (stopPollingRef.current?.(thrown)) stopped.current = true;
      setState((prev) => ({
        key,
        data: prev.key === key ? prev.data : undefined,
        error: toError(thrown),
        settled: true,
      }));
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [key]);

  useEffect(() => {
    if (!active) return;
    stopped.current = false;
    const tick = () => {
      if (stopped.current || inFlight.current) return;
      if (pauseWhenHidden && isTabHidden()) return;
      void run();
    };
    const onVisibilityChange = () => {
      if (!isTabHidden()) tick();
    };
    void run();
    const timer = intervalMs ? setInterval(tick, intervalMs) : undefined;
    if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [active, run, intervalMs, pauseWhenHidden]);

  const refresh = useCallback(
    async (refreshOptions?: { skipIfInFlight?: boolean }) => {
      if (!active) return;
      if (refreshOptions?.skipIfInFlight === true && inFlight.current) return;
      await run();
    },
    [active, run],
  );

  const setData = useCallback(
    (next: SetStateAction<T | undefined>) => {
      setState((prev) => {
        const base: State<T> =
          prev.key === key ? prev : { key, data: undefined, error: null, settled: false };
        const data =
          typeof next === 'function'
            ? (next as (previous: T | undefined) => T | undefined)(base.data)
            : next;
        return { ...base, data };
      });
    },
    [key],
  );

  const current = state.key === key ? state : null;
  const error = current?.error ?? null;
  return {
    data: current?.data,
    error,
    errorMessage: error ? describeHttpError(error) : null,
    loading: active && !current?.settled,
    refresh,
    setData,
  };
}

/**
 * {@link usePolledResource} for a plain JSON GET of an API path: the common
 * case of a page that shows one endpoint. `path` doubles as the resource key,
 * so a changed path refetches; `null` keeps the hook idle until the path is
 * known.
 *
 * @typeParam T Shape of the response body (asserted, not validated).
 */
export function useApiResource<T>(
  path: string | null,
  options: PolledResourceOptions = {},
): PolledResource<T> {
  return usePolledResource<T>(
    path,
    (signal) => apiFetch<T>(path ?? '', { signal, timeoutMs: RESOURCE_TIMEOUT_MS }),
    options,
  );
}
