import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test: every `worker-*` service defined in the reference compose
 * file (docker-compose.yml) must also exist in the tk104 dev-stand compose
 * file (compose.tk104.yml), and vice versa.
 *
 * Background: `worker-role-expirer` was added to docker-compose.yml but never
 * mirrored into compose.tk104.yml, so temporary role assignments never
 * expired on tk104 (then production) — no container ran the expirer loop. The two
 * files are maintained by hand in parallel; this test turns a silent drift
 * into a hard failure.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const REFERENCE_COMPOSE = 'docker-compose.yml';
const TK104_COMPOSE = 'compose.tk104.yml';

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

describe('compose.tk104.yml — worker service parity with docker-compose.yml', () => {
  const referenceWorkers = workerServices(REFERENCE_COMPOSE);
  const tk104Workers = workerServices(TK104_COMPOSE);

  it('parses at least one worker service from each compose file', () => {
    expect(referenceWorkers.length).toBeGreaterThan(0);
    expect(tk104Workers.length).toBeGreaterThan(0);
  });

  it('defines the same set of worker-* services in both compose files', () => {
    const missingOnTk104 = referenceWorkers.filter((name) => !tk104Workers.includes(name));
    const extraOnTk104 = tk104Workers.filter((name) => !referenceWorkers.includes(name));

    expect(
      missingOnTk104,
      [
        `Workers defined in ${REFERENCE_COMPOSE} but missing from ${TK104_COMPOSE}: ${missingOnTk104.join(', ')}.`,
        'Every worker must run on tk104 — mirror the service definition',
        `into ${TK104_COMPOSE} (WORKERS_IMAGE image, tk104 postgres/redis URLs,`,
        'logging block) and give it a build in compose.tk104.build.yml.',
      ].join('\n'),
    ).toEqual([]);

    expect(
      extraOnTk104,
      `Workers defined in ${TK104_COMPOSE} but missing from ${REFERENCE_COMPOSE}: ${extraOnTk104.join(', ')}. Add them to ${REFERENCE_COMPOSE} or remove the drift.`,
    ).toEqual([]);
  });
});
