import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * compose.tk104.yml runs the images the deploy workflow pushed to ghcr.io,
 * pinned by digest through the variables scripts/deploy-tk104.sh records in
 * .release.env; it must never build on the host. compose.tk104.build.yml
 * restores the builds for previews. The checks are line-based like
 * compose-tk104-worker-parity.test.ts, without a YAML dependency.
 */

const REPO_ROOT = resolve(__dirname, '../../..');

function read(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf-8');
}

/** Maps each top-level service to the lines of its block. */
function serviceBlocks(file: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | null = null;
  for (const line of read(file).split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim().length > 0) break;
    const service = /^ {2}([\w-]+):\s*$/.exec(line);
    if (service?.[1]) {
      current = [];
      blocks.set(service[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return blocks;
}

const tk104 = serviceBlocks('compose.tk104.yml');
const buildOverride = serviceBlocks('compose.tk104.build.yml');
const releaseServices = [...tk104.keys()].filter(
  (name) => ['migrator', 'api', 'web', 'caddy'].includes(name) || name.startsWith('worker-'),
);

/** The .release.env variable naming each release service's image. */
function imageVariable(service: string): string {
  if (service === 'migrator' || service === 'api') return 'API_IMAGE';
  if (service === 'caddy') return 'CADDY_IMAGE';
  if (service.startsWith('worker-')) return 'WORKERS_IMAGE';
  return 'WEB_IMAGE';
}

function block(service: string): string[] {
  return tk104.get(service) ?? [];
}

/** The lines of a service's `healthcheck:` mapping. */
function healthcheck(service: string): string[] {
  const lines = block(service);
  const start = lines.indexOf('    healthcheck:');
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

describe('compose.tk104.yml release images', () => {
  it('finds the panel services', () => {
    expect(releaseServices).toEqual(expect.arrayContaining(['migrator', 'api', 'web', 'caddy']));
    expect(releaseServices.filter((name) => name.startsWith('worker-')).length).toBeGreaterThan(10);
  });

  it.each(releaseServices)(
    '%s runs the digest-pinned image recorded for the release and never builds',
    (service) => {
      const variable = imageVariable(service);
      expect(block(service)).toContain(`    image: \${${variable}:?${variable}_is_required}`);
      // A fully qualified ghcr.io digest can only resolve to our own image, so
      // the deploy may pull it; `pull_policy: never` would forbid exactly that.
      expect(block(service).some((line) => /^ {4}pull_policy:/.test(line))).toBe(false);
      expect(block(service).some((line) => /^ {4}build:/.test(line))).toBe(false);
    },
  );

  it('never pulls the images the host builds, whose short names would resolve to Docker Hub', () => {
    const hostBuilt = [...tk104].filter(([, lines]) => lines.includes("    profiles: ['images']"));
    expect(hostBuilt.map(([service]) => service).sort()).toEqual([
      'depot-init-image',
      'rnsquadjs-image',
      'squad-server-image',
    ]);
    for (const [service, lines] of hostBuilt) {
      expect(lines, service).toContain('    pull_policy: never');
      expect(
        lines.some((line) => /^ {4}build:/.test(line)),
        `${service} has no build`,
      ).toBe(true);
    }
  });

  it('no longer knows the tag-based image names', () => {
    expect(read('compose.tk104.yml')).not.toMatch(
      /PANEL_IMAGE_TAG|image: squad-panel\/(api|web|workers|caddy-tk104)/,
    );
  });

  it.each(releaseServices.filter((name) => name.startsWith('worker-')))(
    '%s selects its own worker from the shared image',
    (service) => {
      expect(block(service)).toContain(`      WORKER: ${service.slice('worker-'.length)}`);
    },
  );

  it('keeps a host build for every release service in compose.tk104.build.yml', () => {
    expect([...buildOverride.keys()].sort()).toEqual([...releaseServices].sort());
    for (const [service, lines] of buildOverride) {
      expect(
        lines.some((line) => /^ {4}build:/.test(line)),
        `${service} has no build in the override`,
      ).toBe(true);
      expect(
        lines.some((line) => /^ {4}image:/.test(line)),
        `${service} must take its image name from compose.tk104.yml`,
      ).toBe(false);
    }
  });
});

describe('compose.tk104.yml deploy contract', () => {
  it('keeps the migrator out of `up`: the deploy runs it explicitly, after a backup', () => {
    expect(block('migrator')).toContain("    profiles: ['migrate']");
    for (const [service, lines] of tk104) {
      expect(
        lines.some((line) => /^ {6}migrator:/.test(line)),
        `${service} still depends on the migrator`,
      ).toBe(false);
    }
    expect(read('scripts/deploy-tk104.sh')).toMatch(/compose run --rm -T migrator/);
  });

  it('reports the recorded release version from the api', () => {
    expect(block('api')).toContain(`      APP_VERSION: \${APP_VERSION:-dev}`);
  });

  it.each(['api', 'web'])('%s has a fast healthcheck the deploy can wait on', (service) => {
    const lines = healthcheck(service);
    expect(lines).toContain('      interval: 5s');
    expect(lines.some((line) => /^ {6}start_period: \d+s$/.test(line))).toBe(true);
  });

  it('probes web with node, the only HTTP client in the web runtime image', () => {
    const lines = healthcheck('web');
    expect(lines).toContain('        - node');
    expect(lines.join('\n')).toMatch(/fetch\('http:\/\/127\.0\.0\.1:3000\/dashboard'/);
    expect(read('docker/web.Dockerfile')).not.toMatch(/apt-get install[^\n]*\b(wget|curl)\b/);
  });

  it('never uses start_interval, which Compose refuses on a Docker Engine older than 25', () => {
    expect(read('compose.tk104.yml')).not.toMatch(/^\s+start_interval:/m);
  });

  it('recreates every service whose bind-mounted repository file changes', () => {
    const mounting = [...tk104].filter(([, lines]) =>
      lines.some((line) => /^ {6}- \.\//.test(line)),
    );
    expect(mounting.map(([service]) => service)).toEqual(['caddy']);
    expect(block('caddy')).toContain(`      CADDYFILE_SHA: \${CADDYFILE_SHA:-}`);
    expect(block('caddy')).toContain('      - ./docker/Caddyfile.tk104:/etc/caddy/Caddyfile:ro');
    // The hash compose sees is the one the deploy computes from that file.
    expect(read('scripts/deploy-tk104.sh')).toMatch(
      /caddyfile_sha="\$\(sha256sum < docker\/Caddyfile\.tk104/,
    );
  });
});
