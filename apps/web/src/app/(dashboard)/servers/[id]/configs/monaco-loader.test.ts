// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: () => null,
  DiffEditor: () => null,
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

/**
 * `monaco-editor`'s package `exports` map (0.56.0) only exposes `.` and
 * `./*.js` — `monaco-editor/package.json` is not resolvable through
 * `import()`/`require()` (Node's exports encapsulation rejects it). Resolve
 * the package's real entry point instead and walk up to its root, so the
 * expected CDN version still comes from the installed package rather than a
 * third hardcoded literal.
 */
function installedMonacoEditorVersion(): string {
  const req = createRequire(import.meta.url);
  let dir = path.dirname(req.resolve('monaco-editor'));
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
        version: string;
      };
      if (pkg.name === 'monaco-editor') return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate the monaco-editor package.json');
    dir = parent;
  }
}

describe('monaco loader CDN pin', () => {
  it('pins the loader to the installed monaco-editor version', async () => {
    const version = installedMonacoEditorVersion();
    const { loader } = await import('@monaco-editor/react');
    await import('./page');
    expect(loader.config).toHaveBeenCalledWith({
      paths: { vs: `https://cdn.jsdelivr.net/npm/monaco-editor@${version}/min/vs` },
    });
  });
});
