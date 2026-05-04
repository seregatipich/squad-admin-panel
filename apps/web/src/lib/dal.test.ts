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

vi.mock('./api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
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
import { getSession, requireSession, SESSION_COOKIE } from './dal';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nextHeaders.cookies).mockResolvedValue({
    get: (name: string) => (name === '__Host-sid' ? { value: 'test-session' } : undefined),
  } as Awaited<ReturnType<typeof nextHeaders.cookies>>);
  vi.mocked(apiModule.apiFetch).mockResolvedValue({
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

  it('returns null when apiFetch throws', async () => {
    vi.mocked(apiModule.apiFetch).mockRejectedValueOnce(new Error('Network failure'));

    const me = await getSession();
    expect(me).toBeNull();
  });
});

describe('requireSession', () => {
  it('is defined as a function', () => {
    expect(typeof requireSession).toBe('function');
  });

  it('returns Me when session is valid', async () => {
    const me = await requireSession();
    expect(me.steam_id64).toBe('76561198000000001');
  });

  it('redirects to /login when session is absent', async () => {
    vi.mocked(nextHeaders.cookies).mockResolvedValue({
      get: () => undefined,
    } as unknown as Awaited<ReturnType<typeof nextHeaders.cookies>>);

    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT:/login');
  });
});
