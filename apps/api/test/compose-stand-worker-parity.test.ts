import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test: every `worker-*` service defined in the reference compose
 * file (docker/compose.yml) must also exist in the dev-stand compose
 * file (docker/compose.stand.yml), and vice versa.
 *
 * Background: `worker-role-expirer` was added to docker/compose.yml but never
 * mirrored into docker/compose.stand.yml, so temporary role assignments never
 * expired on the stand host (then production) — no container ran the expirer loop. The two
 * files are maintained by hand in parallel; this test turns a silent drift
 * into a hard failure.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const REFERENCE_COMPOSE = 'docker/compose.yml';
const STAND_COMPOSE = 'docker/compose.stand.yml';

/**
 * Extracts top-level service names (2-space-indented keys under `services:`)
 * from a compose file. Deliberately mirrors the line-based parsing used in
 * compose-bridge-perms.test.ts instead of pulling in a YAML dependency.
 */
function parseServiceNames(yaml: string): string[] {
  const names: string[] = [];
  let inServices = false;
  for (const line of yaml.split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim().length > 0) break;
    const serviceMatch = /^ {2}([\w-]+):\s*$/.exec(line);
    if (serviceMatch?.[1]) names.push(serviceMatch[1]);
  }
  return names;
}

function workerServices(composeFile: string): string[] {
  const yaml = readFileSync(resolve(REPO_ROOT, composeFile), 'utf-8');
  return parseServiceNames(yaml)
    .filter((name) => name.startsWith('worker-'))
    .sort();
}

describe('docker/compose.stand.yml — worker service parity with docker/compose.yml', () => {
  const referenceWorkers = workerServices(REFERENCE_COMPOSE);
  const standWorkers = workerServices(STAND_COMPOSE);

  it('parses at least one worker service from each compose file', () => {
    expect(referenceWorkers.length).toBeGreaterThan(0);
    expect(standWorkers.length).toBeGreaterThan(0);
  });

  it('defines the same set of worker-* services in both compose files', () => {
    const missingOnStand = referenceWorkers.filter((name) => !standWorkers.includes(name));
    const extraOnStand = standWorkers.filter((name) => !referenceWorkers.includes(name));

    expect(
      missingOnStand,
      [
        `Workers defined in ${REFERENCE_COMPOSE} but missing from ${STAND_COMPOSE}: ${missingOnStand.join(', ')}.`,
        'Every worker must run on the stand — mirror the service definition',
        `into ${STAND_COMPOSE} (WORKERS_IMAGE image, the stand's postgres/redis URLs,`,
        'logging block).',
      ].join('\n'),
    ).toEqual([]);

    expect(
      extraOnStand,
      `Workers defined in ${STAND_COMPOSE} but missing from ${REFERENCE_COMPOSE}: ${extraOnStand.join(', ')}. Add them to ${REFERENCE_COMPOSE} or remove the drift.`,
    ).toEqual([]);
  });
});
