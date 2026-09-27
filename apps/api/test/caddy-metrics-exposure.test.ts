import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for #9: the API's Prometheus registry (`GET /metrics`) is an
 * operator-only endpoint and must never be reverse-proxied to the internet.
 * Both Caddyfiles route the `@api` matcher to `api:3000`; this test pins that
 * matcher's path list so `/metrics` cannot silently come back into it.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const CADDYFILES = ['docker/Caddyfile', 'docker/Caddyfile.stand'];

function apiMatcherPaths(caddyfile: string): string[] {
  const line = caddyfile.split('\n').find((l) => /^\s*@api\s+path\s/.test(l));
  if (!line) throw new Error('no `@api path ...` matcher found');
  return line.trim().split(/\s+/).slice(2);
}

describe.each(CADDYFILES)('%s', (file) => {
  const paths = apiMatcherPaths(readFileSync(resolve(REPO_ROOT, file), 'utf-8'));

  it('proxies the API, health and readiness paths', () => {
    expect(paths).toEqual(expect.arrayContaining(['/api/*', '/health', '/ready']));
  });

  it('does not proxy the operator-only /metrics endpoint', () => {
    expect(paths.some((p) => p === '/metrics' || p.startsWith('/metrics'))).toBe(false);
  });
});
