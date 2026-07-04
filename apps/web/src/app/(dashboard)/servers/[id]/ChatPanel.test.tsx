import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn(),
  useLiveBusState: vi.fn(() => 'open'),
}));

import { ChatPanel } from './ChatPanel';

describe('ChatPanel', () => {
  it('is a valid React component', () => {
    expect(ChatPanel).toBeDefined();
    expect(typeof ChatPanel).toBe('function');
  });
});
