import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for the `calc.${APP_DOMAIN}` site of the stand Caddyfile (SquadCalc, proxied to a
 * service that runs on the stand host outside the stack). The site must get its certificate the
 * same way as the panel (DNS-01 through DuckDNS: port 80 is not forwarded), must never reach
 * the panel's own upstreams, and the caddy service must be able to resolve the host alias.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const caddyfile = readFileSync(resolve(REPO_ROOT, 'docker/Caddyfile.stand'), 'utf-8');
const compose = readFileSync(resolve(REPO_ROOT, 'docker/compose.stand.yml'), 'utf-8');

function siteBlock(source: string, address: string): string {
  const start = source.indexOf(`\n${address} {\n`);
  if (start === -1) throw new Error(`no site block for ${address}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3);
}

describe('docker/Caddyfile.stand calc site', () => {
  const calc = siteBlock(caddyfile, 'calc.{$APP_DOMAIN}');

  it('issues its certificate through DuckDNS DNS-01 like the panel site', () => {
    expect(calc).toMatch(
      /^\ttls \{\n\t\tdns duckdns \{env\.DUCKDNS_TOKEN\}\n\t\tresolvers 1\.1\.1\.1 8\.8\.8\.8\n\t\}$/m,
    );
  });

  it('proxies everything to SQUADCALC_UPSTREAM, defaulting to port 9910 of the host', () => {
    expect(calc).toMatch(/^\treverse_proxy \{\$SQUADCALC_UPSTREAM:host\.docker\.internal:9910\}$/m);
  });

  it('never reaches the panel upstreams', () => {
    expect(calc).not.toMatch(/api:3000|web:3000/);
  });

  it('leaves the panel site untouched: api, internal 404 and web catch-all', () => {
    const panel = siteBlock(caddyfile, '{$APP_DOMAIN}');
    expect(panel).toMatch(/reverse_proxy api:3000/);
    expect(panel).toMatch(/reverse_proxy web:3000/);
    expect(panel).not.toMatch(/SQUADCALC/);
  });
});

describe('docker/compose.stand.yml caddy service', () => {
  const caddy = compose.slice(
    compose.indexOf('\n  caddy:\n'),
    compose.indexOf('\n  squad-server-image:'),
  );

  it('passes SQUADCALC_UPSTREAM with the same default as the Caddyfile', () => {
    expect(caddy).toMatch(
      /SQUADCALC_UPSTREAM: \$\{SQUADCALC_UPSTREAM:-host\.docker\.internal:9910\}/,
    );
  });

  it('can resolve host.docker.internal', () => {
    expect(caddy).toMatch(/extra_hosts:\n\s+- "host\.docker\.internal:host-gateway"/);
  });
});
