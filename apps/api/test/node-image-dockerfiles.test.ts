import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for the three Node images — docker/api.Dockerfile,
 * docker/web.Dockerfile and docker/worker.Dockerfile — which every `dev` push
 * rebuilds before it can deploy the stand:
 *
 * - Install layers are keyed on the manifests alone. The web and worker
 *   Dockerfiles used to copy sources before `pnpm install`, so any source
 *   change reinstalled the workspace.
 * - The runtime is a clean production install plus build output, never the
 *   build tree. The runtime stages used to `COPY --from=builder /app /app` and
 *   then run `pnpm install --prod` in place: the copy put every devDependency
 *   (Playwright, Vitest, Biome, Turbo, tsx, …) in a lower layer (#252), and the
 *   in-place prune left them installed as well.
 * - One turbo run builds the app with its workspace packages, instead of one
 *   sequential RUN per package.
 */

const REPO_ROOT = resolve(__dirname, '../../..');

/** Logical instructions: continuation lines joined, whitespace collapsed, comments dropped. */
function instructions(block: string): string[] {
  return block
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Slices a named build stage (`FROM ... AS <name>`) out of a multi-stage
 * Dockerfile, from its `FROM` line up to (but not including) the next `FROM`
 * line or end of file — the line-based, no-parser-dependency idiom of the
 * compose contract tests.
 */
function stage(dockerfile: string, name: string): string[] {
  const lines = dockerfile.split('\n');
  const startPattern = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, 'i');
  const start = lines.findIndex((line) => startPattern.test(line.trim()));
  if (start === -1) throw new Error(`stage "${name}" not found`);
  const next = lines.findIndex((line, i) => i > start && /^FROM\s+/i.test(line.trim()));
  return instructions(lines.slice(start, next === -1 ? lines.length : next).join('\n'));
}

const copies = (stageInstructions: string[]) =>
  stageInstructions.filter((line) => /^(COPY|ADD)\s/i.test(line));

const IMAGES = [
  { path: 'docker/api.Dockerfile', filter: '@squad/api...' },
  { path: 'docker/web.Dockerfile', filter: '@squad/web...' },
  { path: 'docker/worker.Dockerfile', filter: '"./apps/workers/*"' },
] as const;

describe.each(IMAGES)('$path', ({ path, filter }) => {
  const dockerfile = readFileSync(resolve(REPO_ROOT, path), 'utf-8');

  it('collects the lockfile and every package.json without copying sources', () => {
    const manifests = stage(dockerfile, 'manifests');
    expect(copies(manifests)).toEqual([]);
    const collect = manifests.find((line) => line.startsWith('RUN '));
    expect(collect).toContain('--mount=type=bind,target=/context');
    expect(collect).toContain('cp pnpm-lock.yaml pnpm-workspace.yaml /app/');
    expect(collect).toContain('-name package.json');
  });

  it.each(['deps', 'prod-deps'])('keys the %s install on the manifests alone', (name) => {
    const install = stage(dockerfile, name);
    expect(copies(install)).toEqual(['COPY --from=manifests /app/ ./']);
    expect(install.filter((line) => line.includes('pnpm install --frozen-lockfile'))).toHaveLength(
      1,
    );
  });

  it('ships a clean production install and the build output, never the build tree', () => {
    const prodInstall = stage(dockerfile, 'prod-deps').find((line) =>
      line.includes('pnpm install'),
    );
    expect(prodInstall).toContain('pnpm install --frozen-lockfile --prod --offline');
    // Offline from the store the build stage downloaded, so it cannot drift from it.
    expect(prodInstall).toContain('--mount=type=bind,from=deps,source=/pnpm/store');
    expect(copies(stage(dockerfile, 'runtime'))).toEqual([
      'COPY --from=prod-deps /app /app',
      'COPY --from=builder /out /app',
    ]);
  });

  it('builds with a single turbo run', () => {
    const builder = stage(dockerfile, 'builder');
    const builds = builder.filter((line) => /\bbuild\b/.test(line) && line.startsWith('RUN '));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain(`pnpm turbo run build --filter=${filter}`);
    expect(builder.some((line) => /pnpm (--\S+ )*--filter \S+ build/.test(line))).toBe(false);
  });
});

describe('runtime paths the compose files depend on', () => {
  const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf-8');

  it('api: dist/index.js, plus the migrator entry and the migrations it reads', () => {
    const dockerfile = read('docker/api.Dockerfile');
    const collect = stage(dockerfile, 'builder').find((line) => line.includes('/out/'));
    // compose runs the migrator from /app/packages/db as `node dist/migrate.js`,
    // which reads ./drizzle.
    expect(collect).toContain('packages/*/dist');
    expect(collect).toContain('packages/db/drizzle');
    expect(collect).toContain('apps/api/dist');
    const runtime = stage(dockerfile, 'runtime');
    expect(runtime).toContain('WORKDIR /app/apps/api');
    expect(runtime).toContain('CMD ["node", "--enable-source-maps", "dist/index.js"]');
  });

  it('web: the build without its webpack cache, public/ with Monaco, and the config', () => {
    const dockerfile = read('docker/web.Dockerfile');
    const collect = stage(dockerfile, 'builder').find((line) => line.includes('/out/'));
    expect(collect).toContain('rm -rf apps/web/.next/cache');
    expect(collect).toContain('apps/web/.next');
    // public/monaco is vendored at build time (apps/web/scripts/sync-monaco.mjs).
    expect(collect).toContain('apps/web/public');
    expect(collect).toContain('apps/web/next.config.mjs');
    const runtime = stage(dockerfile, 'runtime');
    expect(runtime).toContain('WORKDIR /app/apps/web');
    expect(runtime).toContain('CMD ["pnpm", "start"]');
  });

  it('workers: every worker dist, selected by WORKER, exiting 64 without it', () => {
    const dockerfile = read('docker/worker.Dockerfile');
    const collect = stage(dockerfile, 'builder').find((line) => line.includes('/out/'));
    expect(collect).toContain('apps/workers/*/dist');
    expect(collect).toContain('packages/*/dist');
    const runtime = stage(dockerfile, 'runtime');
    const cmd = runtime.find((line) => line.startsWith('CMD '));
    expect(cmd).toContain('exit 64');
    expect(cmd).toContain('/app/apps/workers/$WORKER');
    expect(cmd).toContain('dist/index.js');
  });
});
