import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #151: `POST /api/v1/host/docker-prune` runs `docker system prune -a` with
 * `--filter label!=panel.preserve=true`. The deploy keeps the running and the
 * previous release's panel images loaded so a rollback needs nothing from the
 * registry; an unlabelled release image would be pruned and break that. Every
 * release image's final stage must therefore carry the label, and the bridge
 * must keep filtering on it.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const RELEASE_DOCKERFILES = [
  'docker/api.Dockerfile',
  'docker/web.Dockerfile',
  'docker/worker.Dockerfile',
  'docker/caddy-duckdns.Dockerfile',
];

/** Instructions of the last build stage, continuation lines joined. */
function finalStage(dockerfile: string): string[] {
  const lines = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const lastFrom = lines.map((line) => /^FROM\s/i.test(line)).lastIndexOf(true);
  return lines.slice(lastFrom);
}

describe.each(RELEASE_DOCKERFILES)('%s', (path) => {
  it('labels the runtime image panel.preserve=true', () => {
    const stage = finalStage(readFileSync(resolve(REPO_ROOT, path), 'utf-8'));
    expect(stage.some((line) => /^LABEL\s.*\bpanel\.preserve=true\b/i.test(line))).toBe(true);
  });
});

describe('bridge docker prune', () => {
  it('spares images labelled panel.preserve=true', () => {
    const runner = readFileSync(
      resolve(REPO_ROOT, 'apps/bridge/internal/runner/docker.go'),
      'utf-8',
    );
    expect(runner).toContain('"--filter", "label!=panel.preserve=true"');
  });
});
