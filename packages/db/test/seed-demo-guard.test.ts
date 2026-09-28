import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEMO_ADMIN_STEAM_ID, seedDemoRefusal } from '../src/seed-demo.js';

/**
 * Issue #52 finding 1146: the demo seeder grants Owner to a fixed SteamID and
 * prints an Owner session token. Nothing but a comment kept it off production,
 * and it was compiled into dist/ and shipped in the API image.
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_URL = 'postgres://admin:secret@127.0.0.1:5432/admin';

describe('seedDemoRefusal', () => {
  it('allows a local database outside production', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'postgres']) {
      expect(seedDemoRefusal({ DATABASE_URL: `postgres://u:p@${host}:5432/db` }), host).toBeNull();
    }
  });

  it('refuses when DATABASE_URL is missing or unparsable', () => {
    expect(seedDemoRefusal({})).toMatch(/DATABASE_URL is required/);
    expect(seedDemoRefusal({ DATABASE_URL: 'not a url' })).toMatch(/not a valid URL/);
  });

  it('refuses under NODE_ENV=production even for a local database', () => {
    expect(seedDemoRefusal({ DATABASE_URL: LOCAL_URL, NODE_ENV: 'production' })).toMatch(
      /NODE_ENV=production/,
    );
    expect(
      seedDemoRefusal({
        DATABASE_URL: LOCAL_URL,
        NODE_ENV: 'production',
        SEED_DEMO_ALLOW_REMOTE: '1',
      }),
    ).toMatch(/NODE_ENV=production/);
  });

  it('refuses a non-local database host unless explicitly allowed', () => {
    const remote = { DATABASE_URL: 'postgres://u:p@db.example.com:5432/panel' };
    expect(seedDemoRefusal(remote)).toMatch(/db\.example\.com/);
    expect(seedDemoRefusal({ ...remote, SEED_DEMO_ALLOW_REMOTE: '1' })).toBeNull();
  });
});

describe('seed-demo script', () => {
  it('exits non-zero without touching a remote database', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'src/seed-demo.ts'], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/panel' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to seed demo data/);
  });

  it('uses a demo Owner SteamID below the individual-account range, owned by no real player', () => {
    // 76561197960265728 is the first individual Steam64 ID.
    expect(DEMO_ADMIN_STEAM_ID).toBeLessThan(76561197960265728n);
  });

  it('is left out of the build, so dist/ and the API image never ship it', () => {
    const files = execFileSync(
      'pnpm',
      ['exec', 'tsc', '-p', 'tsconfig.build.json', '--listFilesOnly'],
      {
        cwd: PACKAGE_DIR,
        encoding: 'utf8',
      },
    );
    expect(files).toContain('src/index.ts');
    expect(files).not.toContain('seed-demo');
  });
});
