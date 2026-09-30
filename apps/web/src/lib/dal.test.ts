import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: (name: string) => (name === '__Host-sid' ? { value: 'test-session' } : undefined),
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  apiFetch: vi.fn().mockResolvedValue({
    player_id: 'b1e2c3d4-0000-0000-0000-000000000001',
    steam_id64: '76561198000000001',
    canonical_name: 'TestUser',
    avatar_url: null,
    permissions: ['servers.view'],
  }),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: (fn: unknown) => fn };
});

import * as nextHeaders from 'next/headers';
import * as apiModule from './api';
import { getSession, parseMe, requireSession, SESSION_COOKIE } from './dal';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nextHeaders.cookies).mockResolvedValue({
    get: (name: string) => (name === '__Host-sid' ? { value: 'test-session' } : undefined),
  } as Awaited<ReturnType<typeof nextHeaders.cookies>>);
  vi.mocked(apiModule.apiFetch).mockResolvedValue({
    player_id: 'b1e2c3d4-0000-0000-0000-000000000001',
    steam_id64: '76561198000000001',
    canonical_name: 'TestUser',
    avatar_url: null,
    permissions: ['servers.view'],
  } as never);
});

describe('SESSION_COOKIE', () => {
  it('equals __Host-sid', () => {
    expect(SESSION_COOKIE).toBe('__Host-sid');
  });
});

describe('getSession', () => {
  it('is defined as a function', () => {
    expect(typeof getSession).toBe('function');
  });

  it('returns Me object when session cookie is present', async () => {
    const me = await getSession();
    expect(me).not.toBeNull();
    expect(me?.player_id).toBe('b1e2c3d4-0000-0000-0000-000000000001');
    expect(me?.steam_id64).toBe('76561198000000001');
    expect(me?.canonical_name).toBe('TestUser');
  });

  it('returns null when no session cookie', async () => {
    vi.mocked(nextHeaders.cookies).mockResolvedValue({
      get: () => undefined,
    } as unknown as Awaited<ReturnType<typeof nextHeaders.cookies>>);

    const me = await getSession();
    expect(me).toBeNull();
  });

  it.each([401, 403])('returns null when the API rejects the session with %i', async (status) => {
    vi.mocked(apiModule.apiFetch).mockRejectedValueOnce(
      new apiModule.ApiError('/api/v1/me', status, 'no session'),
    );

    const me = await getSession();
    expect(me).toBeNull();
  });

  // #827: сбой API — не разлогин. Ошибка уходит в границу ошибки, а не в /login.
  it('rethrows a server error instead of reporting no session', async () => {
    const failure = new apiModule.ApiError('/api/v1/me', 503, 'Service Unavailable');
    vi.mocked(apiModule.apiFetch).mockRejectedValueOnce(failure);

    await expect(getSession()).rejects.toBe(failure);
  });

  it('rethrows a network failure or timeout instead of reporting no session', async () => {
    vi.mocked(apiModule.apiFetch).mockRejectedValueOnce(new Error('Network failure'));

    await expect(getSession()).rejects.toThrow('Network failure');
  });
});

describe('requireSession', () => {
  it('is defined as a function', () => {
    expect(typeof requireSession).toBe('function');
  });

  it('returns Me when session is valid', async () => {
    const me = await requireSession();
    expect(me.player_id).toBe('b1e2c3d4-0000-0000-0000-000000000001');
  });

  it('redirects to /login when session is absent', async () => {
    vi.mocked(nextHeaders.cookies).mockResolvedValue({
      get: () => undefined,
    } as unknown as Awaited<ReturnType<typeof nextHeaders.cookies>>);

    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('does not redirect to /login when the API is down', async () => {
    vi.mocked(apiModule.apiFetch).mockRejectedValueOnce(
      new apiModule.ApiError('/api/v1/me', 502, 'Bad Gateway'),
    );

    await expect(requireSession()).rejects.toMatchObject({ status: 502 });
  });
});

describe('parseMe (#819)', () => {
  const valid = {
    player_id: 'b1e2c3d4-0000-0000-0000-000000000001',
    canonical_name: 'TestUser',
    permissions: ['servers.view'],
  };

  it('accepts a body with the fields the layout dereferences', () => {
    expect(parseMe(valid)).toBe(valid);
  });

  it.each([
    ['not an object', null],
    ['no permissions', { ...valid, permissions: undefined }],
    ['permissions not an array', { ...valid, permissions: 'servers.view' }],
    ['a non-string permission', { ...valid, permissions: [1] }],
    ['no player_id', { ...valid, player_id: undefined }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseMe(body)).toThrow();
  });

  it('asks apiFetch to validate the session response', async () => {
    await getSession();
    expect(apiModule.apiFetch).toHaveBeenCalledWith(
      '/api/v1/me',
      expect.objectContaining({ parse: parseMe }),
    );
  });
});
