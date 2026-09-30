// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSavedFlag } from './useSavedFlag';

afterEach(() => {
  vi.useRealTimers();
});

describe('useSavedFlag', () => {
  it('raises the flag for two seconds, and clearSaved drops it at once', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSavedFlag());

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current[0]).toBe(false);

    act(() => result.current[1]());
    act(() => result.current[2]());
    expect(result.current[0]).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the pending timer on unmount (#657)', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSavedFlag());

    act(() => result.current[1]());
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
