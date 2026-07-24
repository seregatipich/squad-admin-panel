import { describe, expect, it, vi } from 'vitest';
import { handleForcedLogout } from './forcedLogout';

describe('handleForcedLogout', () => {
  it('redirects when /api/v1/me reports the session is gone (401)', async () => {
    const redirect = vi.fn();
    await handleForcedLogout({ fetchMe: async () => ({ status: 401 }), redirect });
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('leaves the tab alone when the session is still valid (200 — another device revoked)', async () => {
    const redirect = vi.fn();
    await handleForcedLogout({ fetchMe: async () => ({ status: 200 }), redirect });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not redirect on a transient server error (5xx)', async () => {
    const redirect = vi.fn();
    await handleForcedLogout({ fetchMe: async () => ({ status: 503 }), redirect });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('swallows network failures without redirecting', async () => {
    const redirect = vi.fn();
    await handleForcedLogout({
      fetchMe: async () => {
        throw new Error('network down');
      },
      redirect,
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});
