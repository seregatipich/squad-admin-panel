import { describe, expect, it } from 'vitest';
import nextConfig from './next.config.mjs';

describe('next.config redirects', () => {
  it('sends legacy /roles routes to /settings/groups with a permanent redirect', async () => {
    const redirects = await nextConfig.redirects();
    expect(redirects).toContainEqual({
      source: '/roles',
      destination: '/settings/groups',
      permanent: true,
    });
    expect(redirects).toContainEqual({
      source: '/roles/:path*',
      destination: '/settings/groups',
      permanent: true,
    });
  });

  it('keeps the legacy /players -> /all-players redirect', async () => {
    const redirects = await nextConfig.redirects();
    expect(redirects).toContainEqual({
      source: '/players',
      destination: '/all-players',
      permanent: true,
    });
  });
});
