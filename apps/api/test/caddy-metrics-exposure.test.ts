import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for #9 and #47: the API's Prometheus registry
 * (`GET /metrics`) and its dependency probe (`GET /ready`, which runs a
 * Postgres query, a Redis PING and a bridge RPC per request) are operator-only
 * endpoints and must never be reverse-proxied to the internet. Both Caddyfiles
 * route the `@api` matcher to `api:3000` and everything else to `web`; this
 * test pins that matcher's path list and the explicit 404 for the internal
 * paths, so neither can silently come back.
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

  it('proxies the API and the liveness path', () => {
    expect(paths).toEqual(expect.arrayContaining(['/api/*', '/health']));
  });

  for (const internal of ['/metrics', '/ready']) {
    it(`does not proxy the operator-only ${internal} endpoint to the api`, () => {
      expect(paths.some((p) => p === internal || p.startsWith(internal))).toBe(false);
    });
  }

  it('answers the internal paths with 404 in their own handle block', () => {
    // `handle` blocks are mutually exclusive, and the matcher-less catch-all
    // to web always sorts last, so this block wins for /metrics and /ready.
    // A bare `respond` directive would not: Caddy orders `handle` before it.
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
    expect(source).toMatch(/^\t@internal path \/metrics\* \/ready\*$/m);
    expect(source).toMatch(/^\thandle @internal \{\n\t\trespond 404\n\t\}$/m);
  });
});
