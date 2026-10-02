import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression for #45 (finding #407): the bridge's `docker_prune` runs
 * `docker system prune -a -f --filter label!=panel.preserve=true`, which
 * deletes every unused tagged image without that label. The rnsquadjs
 * sidecar starts with `--pull never`, the restic sidecar is only up during a
 * backup, and scripts/rollback-tk104.sh relies on the previous release's
 * api/web/worker images staying loaded — so every panel-built image must
 * carry the label in its final stage.
 */

const REPO_ROOT = resolve(__dirname, '../..');

const PANEL_IMAGES = [
  'docker/api.Dockerfile',
  'docker/web.Dockerfile',
  'docker/worker.Dockerfile',
  'docker/rnsquadjs.Dockerfile',
  'docker/restic.Dockerfile',
  'docker/caddy-duckdns.Dockerfile',
  'docker/squad-server.Dockerfile',
  'docker/depot-init.Dockerfile',
] as const;

/** Instructions of the last build stage: continuation lines joined, comments dropped. */
function finalStage(dockerfile: string): string[] {
  const lines = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const lastFrom = lines.findLastIndex((line) => /^FROM\s/i.test(line));
  return lines.slice(lastFrom);
}

describe.each(PANEL_IMAGES)('%s', (path) => {
  it('labels the final image panel.preserve=true so docker_prune spares it', () => {
    const stage = finalStage(readFileSync(resolve(REPO_ROOT, path), 'utf-8'));
    const labels = stage.filter((line) => /^LABEL\s/i.test(line)).join(' ');
    expect(labels).toMatch(/(^|\s)panel\.preserve=true(\s|$)/);
  });
});
