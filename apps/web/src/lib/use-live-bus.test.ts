// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const onStateChange = vi.fn(() => () => {});
vi.mock('./live-bus', () => ({
  getLiveBus: () => ({ onStateChange, state: () => 'open', subscribe: () => () => {} }),
}));

import { useLiveBusState } from './use-live-bus';

describe('useLiveBusState', () => {
  it('returns the bus state', () => {
    const { result } = renderHook(() => useLiveBusState());
    expect(result.current).toBe('open');
  });

  it('subscribes once across re-renders', () => {
    onStateChange.mockClear();
    const { rerender } = renderHook(() => useLiveBusState());
    rerender();
    rerender();
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });
});
