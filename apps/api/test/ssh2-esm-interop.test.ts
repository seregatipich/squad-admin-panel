import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Regression: ssh2 is CommonJS. Vitest's interop accepted
 * `import { utils } from 'ssh2'`, but production runs `node dist/index.js`
 * under real Node ESM, where `utils` is not a detectable named export — the
 * api crash-looped on tk104 (2026-09-07) until the routes switched to the
 * default import. This test runs the same check under a real Node ESM
 * loader, not under vitest's transform.
 */
describe('ssh2 CommonJS interop under real Node ESM', () => {
  it('exposes utils.parseKey, Client and Server through the default import', () => {
    const script = [
      "import ssh2 from 'ssh2';",
      "if (typeof ssh2.utils?.parseKey !== 'function') throw new Error('utils.parseKey missing');",
      "if (typeof ssh2.Client !== 'function') throw new Error('Client missing');",
      "if (typeof ssh2.Server !== 'function') throw new Error('Server missing');",
      "console.log('ok');",
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: API_DIR,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });
});
