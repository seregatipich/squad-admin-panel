import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * compose.tk104.yml runs release images that CI built and the deploy workflow
 * loaded; it must never build on the production host or pull those names from
 * a registry. compose.tk104.build.yml restores the builds for previews. The
 * checks are line-based like compose-tk104-worker-parity.test.ts, without a
 * YAML dependency.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const TAG = '${PANEL_IMAGE_TAG:?PANEL_IMAGE_TAG_is_required}';

/** Maps each top-level service to the lines of its block. */
function serviceBlocks(file: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | null = null;
  for (const line of readFileSync(resolve(REPO_ROOT, file), 'utf-8').split('\n')) {
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

const production = serviceBlocks('compose.tk104.yml');
const buildOverride = serviceBlocks('compose.tk104.build.yml');
const releaseServices = [...production.keys()].filter(
  (name) => ['migrator', 'api', 'web', 'caddy'].includes(name) || name.startsWith('worker-'),
);

function expectedImage(service: string): string {
  if (service === 'migrator' || service === 'api') return 'api';
  if (service === 'caddy') return 'caddy-tk104';
  if (service.startsWith('worker-')) return 'workers';
  return service;
}

describe('compose.tk104.yml release images', () => {
  it('finds the panel services', () => {
    expect(releaseServices).toEqual(expect.arrayContaining(['migrator', 'api', 'web', 'caddy']));
    expect(releaseServices.filter((name) => name.startsWith('worker-')).length).toBeGreaterThan(10);
  });

  it.each(releaseServices)(
    '%s runs its tagged release image and never builds or pulls',
    (service) => {
      const block = production.get(service) ?? [];
      expect(block).toContain(`    image: squad-panel/${expectedImage(service)}:${TAG}`);
      expect(block).toContain('    pull_policy: never');
      expect(block.some((line) => /^ {4}build:/.test(line))).toBe(false);
    },
  );

  it.each(releaseServices.filter((name) => name.startsWith('worker-')))(
    '%s selects its own worker from the shared image',
    (service) => {
      expect(production.get(service)).toContain(`      WORKER: ${service.slice('worker-'.length)}`);
    },
  );

  it('keeps a host build for every release service in compose.tk104.build.yml', () => {
    expect([...buildOverride.keys()].sort()).toEqual([...releaseServices].sort());
    for (const [service, block] of buildOverride) {
      expect(
        block.some((line) => /^ {4}build:/.test(line)),
        `${service} has no build in the override`,
      ).toBe(true);
    }
  });
});
