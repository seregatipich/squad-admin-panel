import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../next.config.mjs';

const CONFIGS_ROUTE = '/servers/:id/configs';
const BASE_ROUTE = '/(.*)';
const MONACO_CDN = 'https://cdn.jsdelivr.net';

async function getHeaderEntries() {
  if (typeof nextConfig.headers !== 'function') {
    throw new Error('next.config.mjs default export is missing an async headers() function');
  }
  return nextConfig.headers();
}

function findEntry(entries: Awaited<ReturnType<typeof getHeaderEntries>>, source: string) {
  return entries.find((entry) => entry.source === source);
}

function findHeader(entry: { headers: { key: string; value: string }[] } | undefined, key: string) {
  return entry?.headers.find((header) => header.key === key);
}

async function cspFor(source: string) {
  const entries = await getHeaderEntries();
  return findHeader(findEntry(entries, source), 'Content-Security-Policy')?.value ?? '';
}

describe('next.config.mjs headers()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets Content-Security-Policy, X-Content-Type-Options, and X-Frame-Options on the base '/(.*)' route", async () => {
    const entries = await getHeaderEntries();
    const baseEntry = findEntry(entries, BASE_ROUTE);

    expect(baseEntry).toBeDefined();
    expect(findHeader(baseEntry, 'Content-Security-Policy')?.value).toContain("default-src 'self'");
    expect(findHeader(baseEntry, 'X-Content-Type-Options')?.value).toBe('nosniff');
    expect(findHeader(baseEntry, 'X-Frame-Options')?.value).toBe('DENY');
  });

  it('excludes cdn.jsdelivr.net from the base route policy', async () => {
    const entries = await getHeaderEntries();
    const baseEntry = findEntry(entries, BASE_ROUTE);
    const csp = findHeader(baseEntry, 'Content-Security-Policy')?.value ?? '';

    expect(csp).not.toContain(MONACO_CDN);
  });

  it('widens the /servers/:id/configs route to allow-list cdn.jsdelivr.net for script-src, style-src, and connect-src', async () => {
    const entries = await getHeaderEntries();
    const configsEntry = findEntry(entries, CONFIGS_ROUTE);
    const csp = findHeader(configsEntry, 'Content-Security-Policy')?.value ?? '';

    expect(configsEntry).toBeDefined();
    expect(csp).toContain(`script-src 'self' 'unsafe-inline' ${MONACO_CDN}`);
    expect(csp).toContain(`style-src 'self' 'unsafe-inline' ${MONACO_CDN}`);
    expect(csp).toContain(`connect-src 'self' ${MONACO_CDN}`);
  });

  it('keeps X-Content-Type-Options and X-Frame-Options on the widened /servers/:id/configs route too', async () => {
    const entries = await getHeaderEntries();
    const configsEntry = findEntry(entries, CONFIGS_ROUTE);

    expect(findHeader(configsEntry, 'X-Content-Type-Options')?.value).toBe('nosniff');
    expect(findHeader(configsEntry, 'X-Frame-Options')?.value).toBe('DENY');
  });

  // `next dev` compiles client chunks with an eval-based devtool. Without
  // 'unsafe-eval' the framework runtime is blocked outright, so every page
  // hangs on its unhydrated server fallback — production must not pay for it.
  describe.each([
    ['the base route', BASE_ROUTE],
    ['the /servers/:id/configs route', CONFIGS_ROUTE],
  ])("script-src 'unsafe-eval' on %s", (_label, route) => {
    it('is absent in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      expect(await cspFor(route)).not.toContain("'unsafe-eval'");
    });

    it('is present in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');

      expect(await cspFor(route)).toMatch(/script-src [^;]*'unsafe-eval'/);
    });

    it('is present when NODE_ENV is unset', async () => {
      vi.stubEnv('NODE_ENV', undefined);

      expect(await cspFor(route)).toContain("'unsafe-eval'");
    });
  });

  it('leaves the production base policy byte-for-byte unchanged', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(await cspFor(BASE_ROUTE)).toBe(
      "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
  });

  it('leaves the production configs policy byte-for-byte unchanged', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(await cspFor(CONFIGS_ROUTE)).toBe(
      `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' ${MONACO_CDN}; style-src 'self' 'unsafe-inline' ${MONACO_CDN}; worker-src 'self' blob:; connect-src 'self' ${MONACO_CDN}`,
    );
  });
});
