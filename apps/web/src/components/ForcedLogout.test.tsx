// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { ForcedLogout } from './ForcedLogout';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

type SessionRevokedEvent = Extract<LiveEvent, { type: 'session.revoked' }>;

let revokedHandler: ((event: SessionRevokedEvent) => void) | undefined;
let subscribedType: string | undefined;
let hrefSpy: ReturnType<typeof vi.fn>;

const REVOKED: SessionRevokedEvent = {
  type: 'session.revoked',
  ts: '2026-07-23T00:00:00.000Z',
  data: { player_id: 'player-1', session_id: 'sid-1' },
};

beforeEach(() => {
  vi.mocked(useLiveSubscription).mockImplementation((type, handler) => {
    subscribedType = type;
    revokedHandler = handler as (event: SessionRevokedEvent) => void;
  });
  hrefSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      set href(value: string) {
        hrefSpy(value);
      },
      get href() {
        return 'http://localhost/';
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  revokedHandler = undefined;
  subscribedType = undefined;
});

describe('ForcedLogout', () => {
  it('subscribes to session.revoked and renders nothing', () => {
    const { container } = render(<ForcedLogout />);
    expect(subscribedType).toBe('session.revoked');
    expect(container).toBeEmptyDOMElement();
  });

  it('probes /api/v1/me and redirects to /login when the session is gone', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal('fetch', fetchMock);
    render(<ForcedLogout />);

    revokedHandler?.(REVOKED);
    await vi.waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/login'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/me',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('stays put when /api/v1/me still authenticates (another device revoked)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    render(<ForcedLogout />);

    revokedHandler?.(REVOKED);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(hrefSpy).not.toHaveBeenCalled();
  });
});
