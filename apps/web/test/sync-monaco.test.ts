import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(WEB_ROOT, 'scripts', 'sync-monaco.mjs');
const VENDORED = path.join(WEB_ROOT, 'public', 'monaco', 'vs');
const STAMP = path.join(WEB_ROOT, 'public', 'monaco', '.version');

/**
 * `monaco-editor/package.json` is not resolvable through the package's
 * `exports` map, so walk up from its real entry point instead.
 */
function installedMonacoVersion(): string {
  const require = createRequire(import.meta.url);
  let dir = path.dirname(require.resolve('monaco-editor'));
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version: string };
      if (pkg.name === 'monaco-editor') return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate the monaco-editor package root');
    dir = parent;
  }
}

describe('scripts/sync-monaco.mjs', () => {
  // Runs the real script rather than mocking it: the whole point is that the
  // files the browser will request actually exist on disk after a build.
  it('vendors the installed monaco AMD bundle into public/monaco/vs', () => {
    execFileSync(process.execPath, [SCRIPT], { cwd: WEB_ROOT, stdio: 'pipe' });

    expect(existsSync(path.join(VENDORED, 'loader.js'))).toBe(true);
    expect(existsSync(path.join(VENDORED, 'editor', 'editor.main.js'))).toBe(true);
    expect(existsSync(path.join(VENDORED, 'editor', 'editor.main.css'))).toBe(true);
  });

  it('stamps the vendored copy with the installed monaco-editor version', () => {
    execFileSync(process.execPath, [SCRIPT], { cwd: WEB_ROOT, stdio: 'pipe' });

    expect(readFileSync(STAMP, 'utf8').trim()).toBe(installedMonacoVersion());
  });

  it('is idempotent — a second run skips the copy', () => {
    execFileSync(process.execPath, [SCRIPT], { cwd: WEB_ROOT, stdio: 'pipe' });
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: WEB_ROOT, encoding: 'utf8' });

    expect(out).toContain('already vendored');
  });
});
