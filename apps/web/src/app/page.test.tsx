import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

import Page from './page';

describe('RootPage', () => {
  it('is a valid async function component', () => {
    expect(Page).toBeDefined();
    expect(typeof Page).toBe('function');
  });

  it('calls redirect', async () => {
    const { redirect } = await import('next/navigation');
    await Page();
    expect(redirect).toHaveBeenCalled();
  });
});
