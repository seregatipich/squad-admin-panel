import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import { LivePlayers } from './live-players';

describe('LivePlayers', () => {
  it('is a valid React component', () => {
    expect(LivePlayers).toBeDefined();
    expect(typeof LivePlayers).toBe('function');
  });
});
