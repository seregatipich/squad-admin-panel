import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_TIMEOUT_MS, ApiError, ApiResponseError, apiFetch } from './api';

const originalEnv = process.env.API_URL;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

    const calledUrl: string = mockFetch.mock.calls[0]![0];
    expect(calledUrl).toMatch(/\/api\/v1\/servers$/);
  });

  it('sets accept: application/json header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/me');

    const passedHeaders: Headers = mockFetch.mock.calls[0]![1].headers;
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

    const passedHeaders: Headers = mockFetch.mock.calls[0]![1].headers;
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

  it('uses a relative URL when running in a browser context', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('window', {});

    await apiFetch('/api/v1/players/search?q=abc');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/players/search?q=abc',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('sets content-type for body when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/v1/servers', { method: 'POST', body: JSON.stringify({ name: 'test' }) });

    const passedHeaders: Headers = mockFetch.mock.calls[0]![1].headers;
    expect(passedHeaders.get('content-type')).toBe('application/json');
  });
  it('rejects with an ApiError that carries the HTTP status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });
    vi.stubGlobal('fetch', mockFetch);

    const error = await apiFetch('/api/v1/me').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, path: '/api/v1/me' });
  });

  describe('request timeout', () => {
    // #818: без ограничения зависший API держал SSR-рендер до таймаута undici.
    it('bounds every request with a default timeout signal', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', mockFetch);

      await apiFetch('/api/v1/me');

      expect(timeout).toHaveBeenCalledWith(API_TIMEOUT_MS);
      expect(mockFetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    });

    it('fails fast when the API does not answer in time', async () => {
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
        AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      );
      const hungFetch = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted) reject(init.signal.reason);
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      vi.stubGlobal('fetch', hungFetch);

      await expect(apiFetch('/api/v1/me')).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    it('keeps a signal the caller passed instead of the default timeout', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', mockFetch);
      const controller = new AbortController();

      await apiFetch('/api/v1/me', { signal: controller.signal });

      expect(timeout).not.toHaveBeenCalled();
      expect(mockFetch.mock.calls[0]![1].signal).toBe(controller.signal);
    });
  });
});

describe('apiFetch errors', () => {
  it('throws an ApiError carrying the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    const error = await apiFetch('/api/v1/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe('API /api/v1/x 404: nope');
  });
});

describe('apiFetch response validation (#819)', () => {
  const requireName = (body: unknown): { name: string } => {
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { name?: unknown }).name !== 'string'
    ) {
      throw new Error('name must be a string');
    }
    return body as { name: string };
  };

  it('returns the body the parse check accepted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ name: 'a' })));
    await expect(apiFetch('/api/v1/x', { parse: requireName })).resolves.toEqual({ name: 'a' });
  });

  it('rejects a body that fails the parse check with ApiResponseError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ other: 1 })));
    const error = await apiFetch('/api/v1/x', { parse: requireName }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as Error).message).toBe(
      'API /api/v1/x returned an unexpected body: name must be a string',
    );
  });

  it('reports a non-JSON 2xx body as ApiResponseError instead of a SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(apiFetch('/api/v1/x')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('answers a 204 with undefined and hands undefined to parse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiFetch('/api/v1/x')).resolves.toBeUndefined();
    await expect(apiFetch('/api/v1/x', { parse: requireName })).rejects.toBeInstanceOf(
      ApiResponseError,
    );
  });

  it('does not pass parse to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(Response.json({ name: 'a' }));
    vi.stubGlobal('fetch', mockFetch);
    await apiFetch('/api/v1/x', { parse: requireName });
    expect(mockFetch.mock.calls[0]?.[1]).not.toHaveProperty('parse');
  });
});
