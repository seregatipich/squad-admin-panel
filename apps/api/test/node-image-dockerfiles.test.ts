import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test: docker/web.Dockerfile's `runtime` stage must prune
 * devDependencies after copying the built tree from `builder`, matching the
 * pattern already established by docker/api.Dockerfile and
 * docker/worker.Dockerfile (`COPY --from=builder /app /app` followed by
 * `RUN pnpm install --frozen-lockfile --prod`).
 *
 * Background: unlike its two siblings, the web runtime stage copied the
 * entire builder filesystem verbatim and booted `next start` straight from
 * it, shipping the root workspace's, apps/web's, and packages/shared-config's
 * full devDependencies (Playwright, Vitest, Stryker, Biome, Turbo, tsx, the
 * Anthropic SDK) into the production image (#252).
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const DOCKERFILE_PATH = 'docker/web.Dockerfile';

/**
 * Slices a named build stage (`FROM ... AS <name>`) out of a multi-stage
 * Dockerfile, from its `FROM` line up to (but not including) the next `FROM`
 * line or end of file. Deliberately mirrors the line-based, no-parser-
 * dependency idiom used by compose-tk104-worker-parity.test.ts and
 * compose-backup.test.ts, adapted from compose 2-space-indent boundaries to
 * Dockerfile stage boundaries.
 */
function stageBlock(dockerfile: string, stageName: string): string {
  const lines = dockerfile.split('\n');
  const startPattern = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stageName}\\s*$`, 'i');
  const start = lines.findIndex((line) => startPattern.test(line.trim()));
  if (start === -1) {
    throw new Error(`stage "${stageName}" not found in ${DOCKERFILE_PATH}`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^FROM\s+/i.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const dockerfile = readFileSync(resolve(REPO_ROOT, DOCKERFILE_PATH), 'utf-8');
const runtimeStage = stageBlock(dockerfile, 'runtime');

describe('docker/web.Dockerfile runtime stage prunes devDependencies (#252)', () => {
  it('prunes devDependencies after copying the built tree', () => {
    expect(runtimeStage).toContain('RUN pnpm install --frozen-lockfile --prod');
  });

  it('prunes before WORKDIR so the pruned tree is what pnpm start runs', () => {
    const copyIndex = runtimeStage.indexOf('COPY --from=builder /app /app');
    const pruneIndex = runtimeStage.indexOf('RUN pnpm install --frozen-lockfile --prod');
    const workdirIndex = runtimeStage.indexOf('WORKDIR /app/apps/web');

    expect(copyIndex).toBeGreaterThan(-1);
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(workdirIndex).toBeGreaterThan(-1);
    expect(copyIndex).toBeLessThan(pruneIndex);
    expect(pruneIndex).toBeLessThan(workdirIndex);
  });
});
