/**
 * Vendors the installed `monaco-editor` AMD build into `public/monaco/vs`.
 *
 * The config editor used to pull this bundle from `cdn.jsdelivr.net` (#242).
 * That made the editor unusable for anyone whose network cannot reach the
 * CDN — the panel rendered fine but the Monaco pane hung on "Loading..."
 * forever, because the AMD loader never resolved and `@monaco-editor/react`
 * has no timeout to surface. Serving the bundle from our own origin removes
 * the third-party dependency entirely and lets the page keep a CDN-free CSP.
 *
 * Run before `next dev` and `next build` (see the `dev`/`build` scripts in
 * `package.json`). pnpm does not run `pre*` lifecycle scripts by default, so
 * the call is wired explicitly rather than as `prebuild`.
 *
 * @module scripts/sync-monaco
 */
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = path.join(WEB_ROOT, 'public', 'monaco');
const TARGET_VS = path.join(TARGET_DIR, 'vs');
const STAMP = path.join(TARGET_DIR, '.version');

/**
 * Locates the installed `monaco-editor` package root and reads its version.
 *
 * `monaco-editor/package.json` is not importable — the package's `exports`
 * map only exposes `.` and `./*.js`, and Node's encapsulation rejects the
 * rest — so resolve the real entry point and walk up to the package root
 * instead of hardcoding a `node_modules` layout (pnpm's is not flat).
 *
 * @returns {{ root: string, version: string }} Package root and version.
 * @throws {Error} If the package root cannot be located.
 */
function resolveMonacoEditor() {
  const require = createRequire(import.meta.url);
  let dir = path.dirname(require.resolve('monaco-editor'));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'monaco-editor') return { root: dir, version: pkg.version };
    } catch {
      // not a package root, or unreadable — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate the monaco-editor package root');
    dir = parent;
  }
}

/**
 * Copies the installed monaco AMD bundle into `public/monaco/vs`, skipping
 * the copy when the vendored version already matches.
 *
 * @returns {Promise<void>}
 */
async function syncMonaco() {
  const { root, version } = resolveMonacoEditor();

  const vendored = await readFile(STAMP, 'utf8').catch(() => null);
  if (vendored?.trim() === version) {
    console.log(`monaco-editor@${version} already vendored in public/monaco/vs`);
    return;
  }

  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });
  await cp(path.join(root, 'min', 'vs'), TARGET_VS, { recursive: true });
  await writeFile(STAMP, `${version}\n`, 'utf8');
  console.log(`vendored monaco-editor@${version} into public/monaco/vs`);
}

await syncMonaco();
