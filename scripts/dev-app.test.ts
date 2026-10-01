// biome-ignore-all lint/suspicious/noTemplateCurlyInString: dotenv references under test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
// @ts-expect-error -- plain ESM script with no declaration file; tsx runs it as is.
import { expandReferences, missingSecrets, resolveDevEnvironment } from './dev-app.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Creates a temporary repository root holding the given dotenv files. */
function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dev-app-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files))
    writeFileSync(path.join(root, name), content);
  return root;
}

const COMPOSE_ENV = [
  'POSTGRES_PASSWORD=pgsecret',
  'REDIS_PASSWORD=redissecret',
  'APP_ENCRYPTION_KEY=encryptionkeyencryptionkey1234567890',
  'SESSION_SECRET=sessionsecretsessionsecret1234567890',
  'PANEL_PUBLIC_URL=https://panel.example',
  'DATABASE_URL=postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin',
  '',
].join('\n');

describe('expandReferences', () => {
  it('replaces references, applies :- fallbacks and resolves chains', () => {
    const raw = { A: 'x', B: '${A}-${C:-fallback}', D: '${B}!' };
    assert.deepEqual(expandReferences(raw), { A: 'x', B: 'x-fallback', D: 'x-fallback!' });
  });

  it('takes a non-empty shell value literally and ahead of the file value', () => {
    const raw = { A: 'file', B: 'uses-${A}' };
    // A shell value that happens to contain a reference must not be expanded.
    const result = expandReferences(raw, { A: 'shell-${B}' });
    assert.deepEqual(result, { A: 'shell-${B}', B: 'uses-shell-${B}' });
  });

  it('treats an empty shell value as unset', () => {
    assert.deepEqual(expandReferences({ A: 'file' }, { A: '' }), { A: 'file' });
  });

  it('rejects circular references', () => {
    assert.throws(() => expandReferences({ A: '${B}', B: '${A}' }), /circular reference/);
  });
});

describe('resolveDevEnvironment', () => {
  it('runs the api on 3001 and the web dev server on 3000, wired to each other', () => {
    const result = resolveDevEnvironment({ rootDir: rootWith({ '.env': COMPOSE_ENV }), shell: {} });

    assert.deepEqual(result.files, ['.env']);
    assert.equal(result.apiPort, '3001');
    assert.equal(result.webPort, '3000');
    assert.equal(result.overrides.API_PORT, '3001');
    assert.equal(result.overrides.API_URL, 'http://localhost:3001');
    assert.equal(result.overrides.PANEL_PUBLIC_URL, 'http://localhost:3000');
  });

  it('replaces the compose-internal URLs of .env with host-reachable ones', () => {
    const result = resolveDevEnvironment({ rootDir: rootWith({ '.env': COMPOSE_ENV }), shell: {} });

    assert.equal(result.overrides.DATABASE_URL, 'postgres://admin:pgsecret@127.0.0.1:5432/admin');
    assert.equal(result.overrides.REDIS_URL, 'redis://:redissecret@127.0.0.1:6379');
    assert.equal(result.overrides.APP_ENCRYPTION_KEY, 'encryptionkeyencryptionkey1234567890');
  });

  it('follows the published host ports of a second stack', () => {
    const env = `${COMPOSE_ENV}POSTGRES_HOST_PORT=15432\nREDIS_HOST_PORT=16379\n`;
    const result = resolveDevEnvironment({ rootDir: rootWith({ '.env': env }), shell: {} });

    assert.equal(result.overrides.DATABASE_URL, 'postgres://admin:pgsecret@127.0.0.1:15432/admin');
    assert.equal(result.overrides.REDIS_URL, 'redis://:redissecret@127.0.0.1:16379');
  });

  it('lets .env.local override .env, with references expanded against both', () => {
    const local = [
      'WEB_PORT=4000',
      'API_PORT=4001',
      'DATABASE_URL=postgres://dev:${POSTGRES_PASSWORD}@db.internal:6432/devdb',
      '',
    ].join('\n');
    const result = resolveDevEnvironment({
      rootDir: rootWith({ '.env': COMPOSE_ENV, '.env.local': local }),
      shell: {},
    });

    assert.deepEqual(result.files, ['.env', '.env.local']);
    assert.equal(result.webPort, '4000');
    assert.equal(result.apiPort, '4001');
    assert.equal(result.overrides.API_URL, 'http://localhost:4001');
    assert.equal(result.overrides.PANEL_PUBLIC_URL, 'http://localhost:4000');
    assert.equal(result.overrides.DATABASE_URL, 'postgres://dev:pgsecret@db.internal:6432/devdb');
  });

  it('lets variables already set in the shell win over both files', () => {
    const result = resolveDevEnvironment({
      rootDir: rootWith({ '.env': COMPOSE_ENV, '.env.local': 'API_PORT=4001\n' }),
      shell: {
        API_PORT: '5001',
        DATABASE_URL: 'postgres://admin:isolated@127.0.0.1:5432/test_slug',
        POSTGRES_PASSWORD: '',
      },
    });

    assert.equal(result.apiPort, '5001');
    assert.equal(result.overrides.API_URL, 'http://localhost:5001');
    assert.equal(
      result.overrides.DATABASE_URL,
      'postgres://admin:isolated@127.0.0.1:5432/test_slug',
    );
    assert.equal(result.overrides.POSTGRES_PASSWORD, 'pgsecret');
  });

  it('works without .env.local and reports no files when there is no .env either', () => {
    const result = resolveDevEnvironment({ rootDir: rootWith({}), shell: {} });

    assert.deepEqual(result.files, []);
    assert.equal(result.apiPort, '3001');
  });

  it('agrees with the local-development block documented in .env.example', () => {
    const documented: Record<string, string> = {};
    for (const line of readFileSync(path.join(REPOSITORY_ROOT, '.env.example'), 'utf8').split(
      '\n',
    )) {
      const match = /^# (DATABASE_URL|REDIS_URL|API_PORT|WEB_PORT)=(.*)$/.exec(line);
      if (match?.[1] && match[2] !== undefined) documented[match[1]] = match[2];
    }
    const result = resolveDevEnvironment({ rootDir: rootWith({ '.env': COMPOSE_ENV }), shell: {} });

    assert.deepEqual(Object.keys(documented).sort(), [
      'API_PORT',
      'DATABASE_URL',
      'REDIS_URL',
      'WEB_PORT',
    ]);
    assert.deepEqual(
      expandReferences(documented, {
        POSTGRES_PASSWORD: 'pgsecret',
        REDIS_PASSWORD: 'redissecret',
      }),
      {
        API_PORT: result.overrides.API_PORT,
        WEB_PORT: result.overrides.WEB_PORT,
        DATABASE_URL: result.overrides.DATABASE_URL,
        REDIS_URL: result.overrides.REDIS_URL,
      },
    );
  });
});

describe('missingSecrets', () => {
  it('is empty once the secrets and passwords are filled in', () => {
    const { overrides } = resolveDevEnvironment({
      rootDir: rootWith({ '.env': COMPOSE_ENV }),
      shell: {},
    });
    assert.deepEqual(missingSecrets(overrides), []);
  });

  it('names what a fresh copy of .env.example still lacks', () => {
    const { overrides } = resolveDevEnvironment({
      rootDir: rootWith({
        '.env': readFileSync(path.join(REPOSITORY_ROOT, '.env.example'), 'utf8'),
      }),
      shell: {},
    });
    assert.deepEqual(missingSecrets(overrides), [
      'APP_ENCRYPTION_KEY',
      'SESSION_SECRET',
      'POSTGRES_PASSWORD',
      'REDIS_PASSWORD',
    ]);
  });
});

describe('dev:app command line', () => {
  function runPrint(files: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
    const root = rootWith(files);
    mkdirSync(path.join(root, 'scripts'));
    copyFileSync(
      path.join(REPOSITORY_ROOT, 'scripts/dev-app.mjs'),
      path.join(root, 'scripts/dev-app.mjs'),
    );
    return spawnSync(process.execPath, [path.join(root, 'scripts/dev-app.mjs'), '--print'], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  }

  it('prints the resolved settings with the passwords masked and starts nothing', () => {
    const result = runPrint({ '.env': COMPOSE_ENV });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      files: ['.env'],
      api: 'http://127.0.0.1:3001',
      web: 'http://localhost:3000',
      API_URL: 'http://localhost:3001',
      PANEL_PUBLIC_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://admin:***@127.0.0.1:5432/admin',
      REDIS_URL: 'redis://:***@127.0.0.1:6379',
    });
    assert.doesNotMatch(result.stdout, /pgsecret|redissecret/);
  });

  it('fails with the next step when .env is missing', () => {
    const result = runPrint({});

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cp \.env\.example \.env/);
  });

  it('fails naming the blank secrets', () => {
    const result = runPrint({
      '.env': COMPOSE_ENV.replace(
        'SESSION_SECRET=sessionsecretsessionsecret1234567890',
        'SESSION_SECRET=',
      ),
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /fill in SESSION_SECRET in \.env/);
  });
});

describe('dev:app wiring', () => {
  const readJson = (file: string) =>
    JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8')) as {
      scripts: Record<string, string>;
    };

  it('exposes dev and dev:app as the launcher and keeps the turbo fan-out as dev:all', () => {
    const { scripts } = readJson('package.json');

    assert.equal(scripts['dev:app'], 'node scripts/dev-app.mjs');
    assert.equal(scripts.dev, 'node scripts/dev-app.mjs');
    assert.equal(scripts['dev:all'], 'turbo run dev --parallel');
  });

  it('resolves workspace packages to source in the api watcher', () => {
    assert.match(readJson('apps/api/package.json').scripts.dev ?? '', /--conditions=development/);
  });

  it('lets PORT move the web dev server and keeps 3000 as the default', () => {
    assert.match(
      readJson('apps/web/package.json').scripts.dev ?? '',
      /next dev --port \$\{PORT:-3000\}/,
    );
  });
});
