import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

async function getHeaderEntries() {
  if (typeof nextConfig.headers !== 'function') {
    throw new Error('next.config.mjs default export is missing an async headers() function');
  }
  return nextConfig.headers();
}

describe('next.config.mjs headers()', () => {
  it("sets X-Content-Type-Options and X-Frame-Options on every route '/(.*)'", async () => {
    const entries = await getHeaderEntries();
    const base = entries.find((entry) => entry.source === '/(.*)');

    expect(base?.headers).toEqual(
      expect.arrayContaining([
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ]),
    );
  });

  // The policy carries a per-request nonce, so middleware owns it
  // (src/lib/csp.ts, test/middleware.test.ts). A static policy here would be
  // enforced alongside it, and one with 'unsafe-inline' is what #60 (finding
  // 424) removed.
  it('sets no static Content-Security-Policy', async () => {
    const entries = await getHeaderEntries();
    const keys = entries.flatMap((entry) =>
      entry.headers.map((header) => header.key.toLowerCase()),
    );

    expect(keys).not.toContain('content-security-policy');
  });
});
