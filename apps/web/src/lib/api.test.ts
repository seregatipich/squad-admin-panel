import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';

const originalEnv = process.env.API_URL;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalEnv === undefined) {
    delete process.env.API_URL;
  } else {
    process.env.API_URL = originalEnv;
  }
});

describe('apiFetch', () => {
  it('constructs URL from default API_URL', async () => {
    delete process.env.API_URL;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/me');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://api:3000/api/v1/me',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('constructs URL by prepending API_URL to path', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: 42 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/servers');

    const calledUrl: string = mockFetch.mock.calls[0][0];
    expect(calledUrl).toMatch(/\/api\/v1\/servers$/);
  });

  it('sets accept: application/json header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/me');

    const passedHeaders: Headers = mockFetch.mock.calls[0][1].headers;
    expect(passedHeaders.get('accept')).toBe('application/json');
  });

  it('sets cache: no-store', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/me');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('forwards cookie as header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/me', { cookie: '__Host-sid=abc123' });

    const passedHeaders: Headers = mockFetch.mock.calls[0][1].headers;
    expect(passedHeaders.get('cookie')).toBe('__Host-sid=abc123');
  });

  it('throws with status on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(apiFetch('/api/v1/me')).rejects.toThrow('API /api/v1/me 403: Forbidden');
  });

  it('includes 4xx status in error message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(apiFetch('/api/v1/me')).rejects.toThrow('401');
  });

  it('returns parsed JSON on success', async () => {
    const payload = { steam_id64: '7656119800000001', canonical_name: 'Alice' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await apiFetch<typeof payload>('/api/v1/me');

    expect(result).toEqual(payload);
  });

  it('sets content-type for body when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/servers', { method: 'POST', body: JSON.stringify({ name: 'test' }) });

    const passedHeaders: Headers = mockFetch.mock.calls[0][1].headers;
    expect(passedHeaders.get('content-type')).toBe('application/json');
  });
});
