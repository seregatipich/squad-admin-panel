import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const OPERATIONS_SCRIPTS = [
  'scripts/bootstrap.sh',
  'scripts/deploy-tk104.sh',
  'scripts/deploy-tk104-web.sh',
  'scripts/dev-deploy-tk104.sh',
  'scripts/rollback-tk104.sh',
  'scripts/install-host-bridge.sh',
  'scripts/rebuild.sh',
  'scripts/uninstall.sh',
  'scripts/verify-bridge.sh',
] as const;
const temporaryRoots: string[] = [];

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix} with spaces `));
  temporaryRoots.push(root);
  return root;
}

function copyScript(relativePath: string): { root: string; script: string } {
  const root = temporaryRoot('squad-operations');
  const script = path.join(root, relativePath);
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync(path.join(REPOSITORY_ROOT, relativePath), script);
  chmodSync(script, 0o755);
  return { root, script };
}

function executable(file: string, body: string): void {
  writeFileSync(file, `#!/usr/bin/env bash\nset -u\n${body}\n`, { mode: 0o755 });
}

function shimDirectory(): string {
  const directory = path.join(temporaryRoot('squad-operation-shims'), 'bin');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function loggingShim(directory: string, name: string, body = 'exit 0'): void {
  executable(
    path.join(directory, name),
    [
      `printf '%s' '${name}' >> "\${OPS_LOG:?}"`,
      `for argument in "$@"; do printf '|%s' "$argument" >> "\${OPS_LOG:?}"; done`,
      `printf '\\n' >> "\${OPS_LOG:?}"`,
      body,
    ].join('\n'),
  );
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function runAsync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(options.input);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const [status] = (await once(child, 'close')) as [number | null];
  clearTimeout(timeout);
  return { status, stdout, stderr };
}

function logLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

after(() => {
  for (const root of temporaryRoots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe('operation script static contracts', () => {
  for (const relativePath of OPERATIONS_SCRIPTS) {
    it(`${relativePath} is valid strict-mode Bash`, () => {
      const file = path.join(REPOSITORY_ROOT, relativePath);
      const syntax = run('/bin/bash', ['-n', file]);
      assert.equal(syntax.status, 0, syntax.stderr);
      const source = readFileSync(file, 'utf8');
      assert.match(source, /^#!\/usr\/bin\/env bash\n/);
      assert.match(source, /^set -[^\n]*e[^\n]*u[^\n]*pipefail/m);
    });
  }

  it('destructive rebuild and uninstall flows retain explicit confirmations', () => {
    const rebuild = readFileSync(path.join(REPOSITORY_ROOT, 'scripts/rebuild.sh'), 'utf8');
    const uninstall = readFileSync(path.join(REPOSITORY_ROOT, 'scripts/uninstall.sh'), 'utf8');
    assert.match(rebuild, /Type 'rebuild' to confirm/);
    assert.match(rebuild, /\[\[ "\$answer" == "rebuild" \]\]/);
    assert.match(uninstall, /\[y\/N\]/);
    assert.match(uninstall, /\^\[yY\]\$/);
  });

  it('wires every script contract after database migrations in CI', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const testScripts = packageJson.scripts?.['test:scripts'] ?? '';
    assert.match(testScripts, /--test-concurrency=1/);
    for (const testFile of [
      'scripts/deploy-tk104-workflow.test.ts',
      'scripts/operations-scripts.test.ts',
      'scripts/rnsquadjs-shadow-diff.test.ts',
      'scripts/verify-audit-chain.test.ts',
    ]) {
      assert.match(testScripts, new RegExp(testFile.replaceAll('.', '\\.')));
    }

    const workflow = readFileSync(path.join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const migrations = workflow.indexOf('name: Apply database migrations');
    const scriptTests = workflow.indexOf('name: Run operations and verification script tests');
    assert.ok(migrations >= 0 && scriptTests > migrations);
    assert.match(workflow.slice(scriptTests), /run: pnpm test:scripts/);
  });
});

describe('local pre-push checklist and git hooks', () => {
  const MERGE_BASE = '0123456789abcdef0123456789abcdef01234567';

  interface ChecklistFixture {
    root: string;
    script: string;
    shims: string;
    log: string;
    dbEnvLog: string;
  }

  /**
   * A copy of the checklist whose git, pnpm, gitleaks and node run as shims:
   * git answers from the FAKE_* variables runChecklist sets, pnpm logs every
   * call, prints FAKE_TURBO_LS for `turbo ls` and exits 37 for commands
   * starting with FAKE_FAIL_ON, and every pnpm `turbo run test` records the
   * database it would test against in `dbEnvLog`.
   */
  function checklistFixture(
    packages: Record<string, Record<string, string>> = {},
  ): ChecklistFixture {
    const { root, script } = copyScript('scripts/pre-push-checklist.sh');
    const shims = shimDirectory();
    for (const [directory, files] of Object.entries(packages)) {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, directory, file)), { recursive: true });
        writeFileSync(path.join(root, directory, file), content);
      }
    }
    loggingShim(
      shims,
      'git',
      [
        'case "$1" in',
        '  rev-parse) printf \'%s\\n\' "$FIXTURE_ROOT" ;;',
        '  fetch) exit "$FAKE_FETCH_STATUS" ;;',
        '  merge-base) [ -n "$FAKE_MERGE_BASE" ] || exit 1; printf \'%s\\n\' "$FAKE_MERGE_BASE" ;;',
        '  diff) printf \'%s\' "$FAKE_CHANGED_FILES" ;;',
        '  ls-files) printf \'%s\' "$FAKE_UNTRACKED_FILES" ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
    );
    loggingShim(
      shims,
      'pnpm',
      [
        'case "$*" in',
        '  "-s turbo ls "*) printf \'%s\\n\' "$FAKE_TURBO_LS"; exit 0 ;;',
        '  "turbo run test "*) printf \'%s|%s\\n\' "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$DB_ENV_LOG" ;;',
        'esac',
        'case "$*" in "$FAKE_FAIL_ON"*) exit 37 ;; esac',
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'gitleaks');
    executable(path.join(shims, 'node'), `exec ${JSON.stringify(process.execPath)} "$@"`);
    return {
      root,
      script,
      shims,
      log: path.join(root, 'commands.log'),
      dbEnvLog: path.join(root, 'db-env.log'),
    };
  }

  function runChecklist(
    fixture: ChecklistFixture,
    options: {
      changed?: string[];
      untracked?: string[];
      packages?: { name: string; path: string }[];
      env?: NodeJS.ProcessEnv;
    } = {},
  ): CommandResult {
    const items = options.packages ?? [];
    return run('/bin/bash', [fixture.script], {
      cwd: fixture.root,
      env: {
        OPS_LOG: fixture.log,
        DB_ENV_LOG: fixture.dbEnvLog,
        FIXTURE_ROOT: fixture.root,
        PATH: `${fixture.shims}:/usr/bin:/bin`,
        FAKE_FETCH_STATUS: '0',
        FAKE_MERGE_BASE: MERGE_BASE,
        FAKE_FAIL_ON: '<never>',
        FAKE_CHANGED_FILES: (options.changed ?? []).map((file) => `${file}\n`).join(''),
        FAKE_UNTRACKED_FILES: (options.untracked ?? []).map((file) => `${file}\n`).join(''),
        FAKE_TURBO_LS: JSON.stringify({
          packageManager: 'pnpm9',
          packages: { count: items.length, items },
        }),
        DATABASE_URL: 'postgres://isolated-test-database',
        TEST_DATABASE_URL: 'postgres://isolated-test-database',
        FULL: '',
        SKIP_BUILD: '',
        PREPUSH_TURBO_CONCURRENCY: '',
        ...options.env,
      },
    });
  }

  /** The checklist's own commands, without the git plumbing it reads state with. */
  function checklistCommands(fixture: ChecklistFixture): string[] {
    return logLines(fixture.log).filter(
      (line) => !/^git\|(rev-parse|merge-base|diff|ls-files)\|/.test(line),
    );
  }

  const PLAIN_PACKAGE = { name: '@fixture/plain', path: 'packages/plain' };
  const DB_PACKAGE = { name: '@fixture/db-worker', path: 'apps/workers/db-worker' };
  const REDIS_PACKAGE = { name: '@fixture/redis-src', path: 'packages/redis-src' };
  const API_PACKAGE = { name: '@squad/api', path: 'apps/api' };
  const FIXTURE_PACKAGES = {
    'packages/plain': {
      'test/unit.test.ts': "it('adds', () => expect(1 + 1).toBe(2));\n",
      // Source that reads the variable does not make the package's tests DB-backed.
      'src/env.ts': 'export const url = process.env.DATABASE_URL;\n',
    },
    'apps/workers/db-worker': {
      'test/global-setup.ts': 'const base = process.env.TEST_DATABASE_URL;\n',
    },
    'packages/redis-src': {
      'src/queue.test.ts': 'const redis = process.env.REDIS_URL;\n',
    },
  };

  it('runs the light default checklist in order, scoped to changes since the merge base', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [API_PACKAGE, PLAIN_PACKAGE, DB_PACKAGE],
      changed: [
        'apps/api/src/routes/players.ts',
        'apps/api/test/players.test.ts',
        'apps/api/test/helpers/players.ts',
        'apps/api/test/e2e/install-lifecycle.e2e.test.ts',
        'packages/plain/src/index.ts',
        'apps/workers/db-worker/src/tick.ts',
        'scripts/pre-push-checklist.sh',
      ],
      untracked: ['apps/api/test/integration/new-route.test.ts'],
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(checklistCommands(fixture), [
      'git|fetch|-q|origin|dev',
      'pnpm|exec|biome|check|apps|packages|scripts|docker/rnsquadjs',
      'gitleaks|detect|--config|.gitleaks.toml|--no-banner|--redact|--exit-code|1|--log-opts|origin/dev..HEAD',
      `pnpm|-s|turbo|ls|--filter=[${MERGE_BASE}]|--output=json`,
      `pnpm|turbo|run|typecheck|--filter=...[${MERGE_BASE}]`,
      'pnpm|turbo|run|test|--concurrency=2|--filter=@fixture/plain|--filter=@fixture/db-worker',
      'pnpm|--filter|@squad/api|exec|vitest|run|--passWithNoTests|test/players.test.ts|test/e2e/install-lifecycle.e2e.test.ts|test/integration/new-route.test.ts',
      'pnpm|test:scripts',
    ]);
    assert.deepEqual(logLines(fixture.dbEnvLog), [
      'postgres://isolated-test-database|postgres://isolated-test-database',
    ]);
  });

  it('honours PREPUSH_TURBO_CONCURRENCY for the package tests', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [PLAIN_PACKAGE],
      changed: ['packages/plain/src/index.ts'],
      env: { PREPUSH_TURBO_CONCURRENCY: '5' },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      logLines(fixture.log).includes('pnpm|turbo|run|test|--concurrency=5|--filter=@fixture/plain'),
    );
  });

  it('skips DB-backed suites with a warning instead of failing when no database is available', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [API_PACKAGE, PLAIN_PACKAGE, DB_PACKAGE, REDIS_PACKAGE],
      changed: ['apps/api/test/players.test.ts', 'scripts/verify-done.sh'],
      env: { DATABASE_URL: '', TEST_DATABASE_URL: '' },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = checklistCommands(fixture);
    assert.ok(commands.includes('pnpm|turbo|run|test|--concurrency=2|--filter=@fixture/plain'));
    assert.equal(
      commands.some((line) => line.includes('vitest') || line === 'pnpm|test:scripts'),
      false,
    );
    assert.match(
      result.stdout,
      /DB-backed package tests — skipped \(no database: @fixture\/db-worker @fixture\/redis-src\)/,
    );
    assert.match(result.stdout, /api tests — skipped \(no database: test\/players\.test\.ts\)/);
    assert.match(
      result.stdout,
      /operations and verification script tests — skipped \(no database\)/,
    );
    assert.match(result.stdout, /No database for the DB-backed suites/);
    assert.match(result.stdout, /pre-push checklist passed/);
  });

  it("provisions the worktree's own database when Docker and .env are available", () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    writeFileSync(path.join(fixture.root, '.env'), 'POSTGRES_PASSWORD=unused\n');
    loggingShim(fixture.shims, 'docker');
    executable(
      path.join(fixture.root, 'scripts/new-test-db.sh'),
      [
        'printf \'new-test-db|%s\\n\' "$1" >> "$OPS_LOG"',
        'echo "→ progress goes to stderr" >&2',
        'printf "export DATABASE_URL=\'postgres://worktree-db\'\\n"',
        'printf "export TEST_DATABASE_URL=\'postgres://worktree-db\'\\n"',
      ].join('\n'),
    );
    const result = runChecklist(fixture, {
      packages: [DB_PACKAGE],
      changed: ['apps/workers/db-worker/src/tick.ts'],
      env: { DATABASE_URL: '', TEST_DATABASE_URL: '' },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const slug = `prepush_${path.basename(fixture.root).slice(0, 40)}`;
    const commands = checklistCommands(fixture);
    assert.deepEqual(commands.slice(commands.indexOf('docker|ps')), [
      'docker|ps',
      `new-test-db|${slug}`,
      'pnpm|turbo|run|test|--concurrency=2|--filter=@fixture/db-worker',
    ]);
    assert.deepEqual(logLines(fixture.dbEnvLog), ['postgres://worktree-db|postgres://worktree-db']);
  });

  it('points TEST_DATABASE_URL at an exported DATABASE_URL when only that one is set', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [DB_PACKAGE],
      changed: ['apps/workers/db-worker/src/tick.ts'],
      env: { DATABASE_URL: 'postgres://exported', TEST_DATABASE_URL: '' },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(logLines(fixture.dbEnvLog), ['postgres://exported|postgres://exported']);
  });

  it('runs no api tests when the diff touches api source but no api test file', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [API_PACKAGE],
      changed: ['apps/api/src/routes/players.ts', 'apps/api/test/helpers/players.ts'],
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = checklistCommands(fixture);
    assert.ok(commands.includes(`pnpm|turbo|run|typecheck|--filter=...[${MERGE_BASE}]`));
    assert.equal(
      commands.some((line) => line.startsWith('pnpm|turbo|run|test') || line.includes('vitest')),
      false,
    );
    assert.match(
      result.stdout,
      /api tests — skipped \(no api test file changed; ci runs the suite\)/,
    );
  });

  it('runs test:scripts only when scripts/ or .github/ changed', () => {
    const untouched = checklistFixture(FIXTURE_PACKAGES);
    const packagesOnly = runChecklist(untouched, {
      packages: [PLAIN_PACKAGE],
      changed: ['packages/plain/src/index.ts', 'docs/development/testing.md'],
    });
    assert.equal(packagesOnly.status, 0, `${packagesOnly.stdout}\n${packagesOnly.stderr}`);
    assert.equal(logLines(untouched.log).includes('pnpm|test:scripts'), false);
    assert.match(
      packagesOnly.stdout,
      /operations and verification script tests — skipped \(scripts\/ and \.github\/ unchanged\)/,
    );

    const workflowChanged = checklistFixture(FIXTURE_PACKAGES);
    const workflowOnly = runChecklist(workflowChanged, {
      changed: ['.github/workflows/ci.yml'],
    });
    assert.equal(workflowOnly.status, 0, `${workflowOnly.stdout}\n${workflowOnly.stderr}`);
    assert.deepEqual(checklistCommands(workflowChanged).slice(3), [
      `pnpm|-s|turbo|ls|--filter=[${MERGE_BASE}]|--output=json`,
      'pnpm|test:scripts',
    ]);
    assert.match(
      workflowOnly.stdout,
      /typecheck — skipped \(no package changed since origin\/dev\)/,
    );
  });

  it('blocks the push when a changed package fails its tests', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [PLAIN_PACKAGE],
      changed: ['packages/plain/src/index.ts'],
      env: { FAKE_FAIL_ON: 'turbo run test' },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /package tests \(changed since origin\/dev\) FAILED/);
  });

  it('blocks the push when an operation script contract fails', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      changed: ['scripts/deploy-tk104.sh'],
      env: { FAKE_FAIL_ON: 'test:scripts' },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /operations and verification script tests.*FAILED/);
    assert.ok(logLines(fixture.log).includes('pnpm|test:scripts'));
  });

  it('keeps checking against the local origin/dev when the fetch fails', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [PLAIN_PACKAGE],
      changed: ['packages/plain/src/index.ts'],
      env: { FAKE_FETCH_STATUS: '128' },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /could not fetch origin dev/);
    assert.ok(
      logLines(fixture.log).includes('pnpm|turbo|run|test|--concurrency=2|--filter=@fixture/plain'),
    );
  });

  it('fails when HEAD shares no history with origin/dev', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, { env: { FAKE_MERGE_BASE: '' } });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /changes since origin\/dev — no merge base with origin\/dev/);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('pnpm|turbo')),
      false,
    );
  });

  it('only fetches, lints and scans when nothing changed since origin/dev', () => {
    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(checklistCommands(fixture), [
      'git|fetch|-q|origin|dev',
      'pnpm|exec|biome|check|apps|packages|scripts|docker/rnsquadjs',
      'gitleaks|detect|--config|.gitleaks.toml|--no-banner|--redact|--exit-code|1|--log-opts|origin/dev..HEAD',
      `pnpm|-s|turbo|ls|--filter=[${MERGE_BASE}]|--output=json`,
    ]);
  });

  it('FULL=1 keeps the full gate: build, script contracts, coverage and mutation suites', () => {
    const fixture = checklistFixture();
    const result = runChecklist(fixture, { env: { FULL: '1' } });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(checklistCommands(fixture), [
      'git|fetch|-q|origin|dev',
      'pnpm|turbo|run|typecheck',
      'pnpm|exec|biome|check|.',
      'pnpm|turbo|run|build',
      'gitleaks|detect|--config|.gitleaks.toml|--no-banner|--redact|--exit-code|1|--log-opts|origin/dev..HEAD',
      'pnpm|test:scripts',
      'pnpm|test:cov',
      'pnpm|turbo|run|test:mutation',
    ]);
  });

  it('FULL=1 fails closed without a database and starts no DB-backed suite', () => {
    const fixture = checklistFixture();
    const result = runChecklist(fixture, {
      env: { FULL: '1', SKIP_BUILD: '1', DATABASE_URL: '', TEST_DATABASE_URL: '' },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /tests — no DATABASE_URL and could not auto-provision/);
    assert.match(result.stdout, /build — skipped \(SKIP_BUILD=1\)/);
    const commands = logLines(fixture.log);
    assert.equal(commands.includes('pnpm|test:scripts'), false);
    assert.equal(commands.includes('pnpm|test:cov'), false);
  });

  it('runs web tests without waiting for the Next.js production build', () => {
    const dryRun = run('pnpm', [
      'exec',
      'turbo',
      'run',
      'test',
      'build',
      '--dry=json',
      '--filter=@squad/web',
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const tasks = (
      JSON.parse(dryRun.stdout) as {
        tasks: {
          taskId: string;
          dependencies: string[];
          resolvedTaskDefinition: { env: string[]; outputs: string[] };
        }[];
      }
    ).tasks;
    const webTest = tasks.find((task) => task.taskId === '@squad/web#test');
    const webBuild = tasks.find((task) => task.taskId === '@squad/web#build');
    assert.ok(webTest && webBuild);
    assert.equal(webTest.dependencies.includes('@squad/web#build'), false);
    assert.ok(webTest.dependencies.includes('@squad/shared-config#build'));
    // next.config.mjs bakes API_URL into the rewrites, so it must key the build cache.
    assert.deepEqual(webBuild.resolvedTaskDefinition.env, ['API_URL']);
    assert.ok(webBuild.resolvedTaskDefinition.outputs.includes('.next/**'));
  });

  describe('pre-commit hook', () => {
    const LEFTHOOK_CLI = path.join(REPOSITORY_ROOT, 'node_modules/lefthook/bin/index.js');

    /** A git repo with the real lefthook.yml and `files` staged. */
    function hookRepository(files: Record<string, string>): string {
      const repository = path.join(temporaryRoot('squad-lefthook'), 'repo');
      mkdirSync(repository, { recursive: true });
      copyFileSync(
        path.join(REPOSITORY_ROOT, 'lefthook.yml'),
        path.join(repository, 'lefthook.yml'),
      );
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
        writeFileSync(path.join(repository, file), content);
      }
      for (const args of [
        ['init', '-q'],
        ['add', '-A'],
      ]) {
        const git = run('git', args, { cwd: repository });
        assert.equal(git.status, 0, git.stderr);
      }
      return repository;
    }

    function runPreCommit(repository: string, command: string, shims: string): CommandResult {
      return run(
        process.execPath,
        [
          LEFTHOOK_CLI,
          'run',
          'pre-commit',
          '--commands',
          command,
          '--no-auto-install',
          '--no-tty',
          '--colors',
          'off',
        ],
        {
          cwd: repository,
          env: {
            OPS_LOG: path.join(repository, '..', 'commands.log'),
            PATH: `${shims}:/usr/bin:/bin`,
            LEFTHOOK: '1',
            LEFTHOOK_EXCLUDE: '',
          },
        },
      );
    }

    const BRIDGE_SOURCE = { 'apps/bridge/cmd/panel-host-bridge/main.go': 'package main\n' };

    /** The "not installed" cases hide tools behind a PATH of shims plus /usr/bin:/bin. */
    function onSystemPath(tool: string): string | false {
      const lookup = run('/bin/sh', ['-c', `PATH=/usr/bin:/bin command -v ${tool}`]);
      return lookup.status === 0 && `${tool} is installed in /usr/bin or /bin`;
    }

    it('blocks a commit whose Go files gofmt -s would change', () => {
      const repository = hookRepository(BRIDGE_SOURCE);
      const shims = shimDirectory();
      // gofmt -l lists the file and still exits 0.
      loggingShim(shims, 'gofmt', "printf 'cmd/panel-host-bridge/main.go\\n'; exit 0");
      loggingShim(shims, 'go');

      const result = runPreCommit(repository, 'go-fmt', shims);

      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /not gofmt -s formatted/);
      assert.match(result.stdout, /cmd\/panel-host-bridge\/main\.go/);
      assert.deepEqual(logLines(path.join(repository, '..', 'commands.log')), ['gofmt|-l|-s|.']);
    });

    it('vets the bridge for linux/amd64 once gofmt is clean', () => {
      const repository = hookRepository(BRIDGE_SOURCE);
      const shims = shimDirectory();
      loggingShim(shims, 'gofmt');
      loggingShim(
        shims,
        'go',
        'printf \'env|%s|%s|%s\\n\' "$GOOS" "$GOARCH" "$CGO_ENABLED" >> "$OPS_LOG"',
      );

      const result = runPreCommit(repository, 'go-fmt', shims);

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(logLines(path.join(repository, '..', 'commands.log')), [
        'gofmt|-l|-s|.',
        'go|vet|./...',
        'env|linux|amd64|0',
      ]);
    });

    it('fails the commit when go vet fails', () => {
      const repository = hookRepository(BRIDGE_SOURCE);
      const shims = shimDirectory();
      loggingShim(shims, 'gofmt');
      loggingShim(shims, 'go', 'exit 1');

      const result = runPreCommit(repository, 'go-fmt', shims);

      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    it('skips the Go checks when go is not installed', { skip: onSystemPath('go') }, () => {
      const repository = hookRepository(BRIDGE_SOURCE);

      const result = runPreCommit(repository, 'go-fmt', shimDirectory());

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /skipping gofmt and go vet: go is not on PATH/);
    });

    it('blocks a commit when gitleaks finds a staged secret', () => {
      const repository = hookRepository({ 'notes.txt': 'harmless\n' });
      const shims = shimDirectory();
      loggingShim(shims, 'gitleaks', 'exit 1');

      const result = runPreCommit(repository, 'gitleaks', shims);

      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(logLines(path.join(repository, '..', 'commands.log')), [
        'gitleaks|protect|--staged|--config|.gitleaks.toml|--no-banner|--redact',
      ]);
    });

    it(
      'skips the staged secret scan when gitleaks is not installed',
      { skip: onSystemPath('gitleaks') },
      () => {
        const repository = hookRepository({ 'notes.txt': 'harmless\n' });

        const result = runPreCommit(repository, 'gitleaks', shimDirectory());

        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /skipping the staged secret scan: gitleaks is not installed/);
      },
    );
  });
});

describe('bootstrap and host-bridge preflight boundaries', () => {
  it('bootstrap rejects non-root execution before creating repository state', () => {
    const { root, script } = copyScript('scripts/bootstrap.sh');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(shims, 'id', "printf '1000\\n'; exit 0");
    const result = run('/bin/bash', [script], {
      env: { OPS_LOG: log, PATH: `${shims}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run as root/);
    assert.deepEqual(logLines(log), ['id|-u']);
    assert.equal(existsSync(path.join(root, '.bootstrap-logs')), false);
    assert.equal(existsSync(path.join(root, '.env')), false);
  });

  it('bootstrap propagates host-bridge installer failure and stops before data and secrets', () => {
    const { root, script } = copyScript('scripts/bootstrap.sh');
    executable(
      path.join(root, 'scripts/install-host-bridge.sh'),
      "printf 'installer sentinel\\n'; exit 37",
    );
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(shims, 'id', "printf '0\\n'; exit 0");
    loggingShim(
      shims,
      'grep',
      `if [[ "\${1:-}" == '-oE' ]]; then printf 'Ubuntu 24.04\\n'; fi; exit 0`,
    );
    loggingShim(
      shims,
      'docker',
      "if [[ \"$*\" == '--version' ]]; then printf 'Docker version 27.0.0, build test\\n'; elif [[ \"$*\" == 'compose version --short' ]]; then printf '2.30.0\\n'; fi; exit 0",
    );
    loggingShim(shims, 'openssl');
    loggingShim(
      shims,
      'df',
      "if [[ \"$*\" == *'--output=avail'* ]]; then printf 'Avail\\n100G\\n'; else printf 'Mounted\\n/tmp\\n'; fi; exit 0",
    );
    const result = run('/bin/bash', [script], {
      env: { OPS_LOG: log, PATH: `${shims}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 37);
    assert.match(`${result.stdout}\n${result.stderr}`, /install-host-bridge\.sh.*failed/);
    assert.match(result.stderr, /Installation aborted/);
    assert.equal(existsSync(path.join(root, 'data')), false);
    assert.equal(existsSync(path.join(root, '.env')), false);
    assert.match(
      readFileSync(path.join(root, '.bootstrap-logs', '2-install-host-bridge.sh.log'), 'utf8'),
      /installer sentinel/,
    );
  });

  it('install-host-bridge rejects unsupported systems before any mutation', () => {
    const { root, script } = copyScript('scripts/install-host-bridge.sh');
    const shims = shimDirectory();
    const log = path.join(root, 'mutations.log');
    executable(path.join(shims, 'grep'), 'exit 1');
    for (const command of ['groupadd', 'useradd', 'mkdir', 'chown', 'install', 'systemctl']) {
      loggingShim(shims, command);
    }
    const result = run('/bin/bash', [script], {
      env: { OPS_LOG: log, PATH: `${shims}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported distro/);
    assert.deepEqual(logLines(log), []);
  });

  it('install-host-bridge stops at the first binary install failure', () => {
    const { root, script } = copyScript('scripts/install-host-bridge.sh');
    const binary = path.join(root, 'apps/bridge/bin/panel-host-bridge');
    mkdirSync(path.dirname(binary), { recursive: true });
    executable(binary, 'exit 0');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    executable(
      path.join(shims, 'grep'),
      `if [[ "\${1:-}" == '-qE' ]]; then exit 0; fi; exec /usr/bin/grep "$@"`,
    );
    loggingShim(
      shims,
      'id',
      "if [[ \"$*\" == '-u squad' ]]; then printf '1001\\n'; else printf '0\\n'; fi; exit 0",
    );
    executable(path.join(shims, 'getent'), "printf 'panel:x:1234:\\n'; exit 0");
    for (const command of ['mkdir', 'chown']) loggingShim(shims, command);
    loggingShim(shims, 'install', 'exit 43');
    loggingShim(shims, 'systemctl');
    const result = run('/bin/bash', [script], {
      env: { OPS_LOG: log, PATH: `${shims}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 43);
    const commands = logLines(log);
    assert.ok(commands.some((line) => line === 'mkdir|-p|/opt/squad-servers'));
    assert.ok(
      commands.some((line) =>
        line.includes(`install|-m|0755|${binary}|/usr/local/bin/panel-host-bridge`),
      ),
    );
    assert.equal(
      commands.some((line) => line.startsWith('systemctl|')),
      false,
    );
  });
});

describe('tk104 deployment command and health boundaries', () => {
  function deployFixture(): {
    root: string;
    script: string;
    log: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/deploy-tk104.sh');
    writeFileSync(path.join(root, '.env.tk104'), 'SAFE_TEST_VALUE=1\n');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(
      shims,
      'docker',
      [
        `if [[ "$*" == *'ps --format'* ]]; then printf '%s\\n' "\${DOCKER_HEALTH_OUTPUT:-api healthy}"; fi`,
        `if [[ "$*" == 'image ls '* ]]; then printf '%s\\n' \${DOCKER_IMAGE_TAGS:-}; fi`,
        `if [[ -n "\${FAIL_DOCKER_MATCH:-}" && "$*" == *"$FAIL_DOCKER_MATCH"* ]]; then exit "\${FAIL_CODE:-41}"; fi`,
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'sleep');
    // CURL_FAIL_TIMES makes the first N probes fail with CURL_EXIT and every
    // later one succeed, modelling caddy finishing its TLS handshake mid-deploy.
    // Without CURL_FAIL_TIMES the shim keeps its original always-CURL_EXIT behaviour.
    loggingShim(
      shims,
      'curl',
      [
        `attempts_file="\${OPS_LOG:?}.curl-attempts"`,
        'attempts=$(( $(cat "$attempts_file" 2>/dev/null || echo 0) + 1 ))',
        'printf "%s" "$attempts" > "$attempts_file"',
        `if [[ -n "\${CURL_FAIL_TIMES:-}" ]]; then`,
        `  if [[ "$attempts" -le "$CURL_FAIL_TIMES" ]]; then exit "\${CURL_EXIT:-35}"; fi`,
        '  exit 0',
        'fi',
        `exit "\${CURL_EXIT:-0}"`,
      ].join('\n'),
    );
    return {
      root,
      script,
      log,
      env: {
        OPS_LOG: log,
        APP_DIR: root,
        PANEL_IMAGE_TAG: RELEASE_SHA,
        PATH: `${shims}:/usr/bin:/bin`,
      },
    };
  }

  const RELEASE_SHA = 'a'.repeat(40);

  it('fails before Docker when the deployment environment file is absent', () => {
    const { root, script } = copyScript('scripts/deploy-tk104.sh');
    const result = run('/bin/bash', [script], { env: { APP_DIR: root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.tk104 is missing/);
  });

  it('refuses to start without a release image tag, before any Docker call', () => {
    const fixture = deployFixture();
    for (const tag of ['', 'bad tag', '-leading-dash']) {
      const result = run('/bin/bash', [fixture.script], {
        env: { ...fixture.env, PANEL_IMAGE_TAG: tag },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /PANEL_IMAGE_TAG must name the release images/);
    }
    assert.deepEqual(logLines(fixture.log), []);
  });

  it('starts the loaded release images without building, then probes and reports status', () => {
    const fixture = deployFixture();
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Deploy complete/);
    const commands = logLines(fixture.log).filter(
      (line) => line.startsWith('docker|') && !line.startsWith('docker|image|ls|'),
    );
    assert.deepEqual(commands, [
      `docker|image|inspect|squad-panel/api:${RELEASE_SHA}`,
      `docker|image|inspect|squad-panel/web:${RELEASE_SHA}`,
      `docker|image|inspect|squad-panel/workers:${RELEASE_SHA}`,
      `docker|image|inspect|squad-panel/caddy-tk104:${RELEASE_SHA}`,
      'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|up|-d|--remove-orphans',
      'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|ps|--format|{{.Service}} {{.Health}}',
      'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|ps',
    ]);
    assert.equal(
      logLines(fixture.log).some((line) => line.includes('|build')),
      false,
    );
    const all = logLines(fixture.log);
    const curlIndex = all.findIndex((line) => line.startsWith('curl|'));
    const statusIndex = all.findLastIndex((line) => line.endsWith('|ps'));
    assert.ok(curlIndex > 1 && curlIndex < statusIndex);
  });

  it('fails before starting anything when a release image is not loaded', () => {
    const fixture = deployFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: {
        ...fixture.env,
        FAIL_DOCKER_MATCH: `image inspect squad-panel/workers:${RELEASE_SHA}`,
        FAIL_CODE: '1',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /squad-panel\/workers:a{40} is not loaded/);
    assert.equal(
      logLines(fixture.log).some((line) => line.includes('|up|')),
      false,
    );
  });

  it('builds the tag on the host through the build override only when asked', () => {
    const fixture = deployFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, DEPLOY_BUILD: '1', PANEL_IMAGE_TAG: 'dev-abc1234' },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = logLines(fixture.log);
    const build = commands.findIndex(
      (line) =>
        line ===
        'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|-f|compose.tk104.build.yml|build',
    );
    const up = commands.findIndex((line) => line.includes('|up|-d|--remove-orphans'));
    assert.ok(build >= 0 && up > build, commands.join('\n'));
  });

  it('records the release, keeps the previous tag for rollback and pins it in the env file', () => {
    const fixture = deployFixture();
    const previous = 'b'.repeat(40);
    writeFileSync(path.join(fixture.root, '.release'), `${previous}\n`);
    writeFileSync(
      path.join(fixture.root, '.env.tk104'),
      `SAFE_TEST_VALUE=1\nPANEL_IMAGE_TAG=${previous}\nAPP_VERSION=${previous}\n`,
    );
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(fixture.root, '.release'), 'utf8'), `${RELEASE_SHA}\n`);
    assert.equal(readFileSync(path.join(fixture.root, '.release.prev'), 'utf8'), `${previous}\n`);
    assert.equal(
      readFileSync(path.join(fixture.root, '.env.tk104'), 'utf8'),
      `SAFE_TEST_VALUE=1\nPANEL_IMAGE_TAG=${RELEASE_SHA}\nAPP_VERSION=${RELEASE_SHA}\n`,
    );
  });

  it('leaves the recorded release and env file alone when the deploy fails', () => {
    const fixture = deployFixture();
    const previous = 'b'.repeat(40);
    writeFileSync(path.join(fixture.root, '.release'), `${previous}\n`);
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, DOCKER_HEALTH_OUTPUT: 'api starting' },
    });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(path.join(fixture.root, '.release'), 'utf8'), `${previous}\n`);
    assert.equal(existsSync(path.join(fixture.root, '.release.prev')), false);
    assert.equal(
      readFileSync(path.join(fixture.root, '.env.tk104'), 'utf8'),
      'SAFE_TEST_VALUE=1\n',
    );
  });

  it('prunes old release images but never the running or previous tag', () => {
    const fixture = deployFixture();
    const previous = 'b'.repeat(40);
    writeFileSync(path.join(fixture.root, '.release'), `${previous}\n`);
    const result = run('/bin/bash', [fixture.script], {
      env: {
        ...fixture.env,
        // Newest first, as `docker image ls` prints them.
        DOCKER_IMAGE_TAGS: `${RELEASE_SHA} ${'c'.repeat(40)} ${previous} ${'d'.repeat(40)} <none>`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const removed = logLines(fixture.log)
      .filter((line) => line.startsWith('docker|image|rm|'))
      .map((line) => line.split('|').at(-1));
    // KEEP_RELEASES=3: running, previous, and the newest other tag survive.
    assert.deepEqual(removed, [
      `squad-panel/api:${'d'.repeat(40)}`,
      `squad-panel/web:${'d'.repeat(40)}`,
      `squad-panel/workers:${'d'.repeat(40)}`,
      `squad-panel/caddy-tk104:${'d'.repeat(40)}`,
    ]);
  });

  it('fails closed when the API never becomes healthy', () => {
    const fixture = deployFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, DOCKER_HEALTH_OUTPUT: 'api starting' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /api did not become healthy/);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('curl|')),
      false,
    );
    assert.doesNotMatch(result.stdout, /Deploy complete/);
  });

  // regression (#290): the Caddy probe used to be a single-shot `curl -f`. The
  // api-health wait above returns as soon as the api container is healthy, but
  // caddy starts in the same `up -d` and needs a moment more to bind 443, so the
  // probe raced the deploy it verifies. Production run 31948383567 went red with
  // curl exit 35 (SSL connect error) 140 ms after caddy started, while the stack
  // was healthy and serving https://tk104.duckdns.org/health with a 200.
  it('retries the Caddy probe while TLS is still coming up, then reports success', () => {
    const fixture = deployFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, CURL_FAIL_TIMES: '3', CURL_EXIT: '35' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Deploy complete/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('curl|'));
    assert.equal(probes.length, 4, 'expected 3 failed probes then one success');
    // The success path must still run the container-status step afterwards.
    assert.equal(
      logLines(fixture.log)
        .filter((line) => line.startsWith('docker|'))
        .at(-1)
        ?.endsWith('|ps'),
      true,
    );
  });

  it('still fails closed, preserving the curl exit code, when the probe never recovers', () => {
    const fixture = deployFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, CURL_EXIT: '35' },
    });
    assert.equal(result.status, 35);
    assert.match(result.stderr, /health probe through Caddy failed after 20 attempts/);
    assert.doesNotMatch(result.stdout, /Deploy complete/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('curl|'));
    assert.equal(probes.length, 20, 'expected the retry budget to be exhausted');
  });

  it('propagates start and HTTP-probe failures without announcing success', () => {
    const upFixture = deployFixture();
    const upFailure = run('/bin/bash', [upFixture.script], {
      env: {
        ...upFixture.env,
        FAIL_DOCKER_MATCH: 'compose --env-file .env.tk104 -f compose.tk104.yml up',
        FAIL_CODE: '47',
      },
    });
    assert.equal(upFailure.status, 47);
    assert.equal(
      logLines(upFixture.log).some((line) => line.startsWith('curl|')),
      false,
    );

    const curlFixture = deployFixture();
    const curlFailure = run('/bin/bash', [curlFixture.script], {
      env: { ...curlFixture.env, CURL_EXIT: '22' },
    });
    assert.equal(curlFailure.status, 22);
    assert.doesNotMatch(curlFailure.stdout, /Deploy complete/);
    assert.equal(
      logLines(curlFixture.log)
        .filter((line) => line.startsWith('docker|'))
        .at(-1)
        ?.endsWith('|ps'),
      false,
    );
  });
});

describe('tk104 web preview and rollback', () => {
  const RELEASE_SHA = 'a'.repeat(40);

  function hostFixture(relativePath: string): {
    root: string;
    script: string;
    log: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript(relativePath);
    writeFileSync(path.join(root, '.env.tk104'), 'SAFE_TEST_VALUE=1\n');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(
      shims,
      'docker',
      [
        `if [[ "$*" == *'ps --format'* ]]; then printf '%s\\n' 'web running'; fi`,
        `if [[ -n "\${FAIL_DOCKER_MATCH:-}" && "$*" == *"$FAIL_DOCKER_MATCH"* ]]; then exit 1; fi`,
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'sleep');
    loggingShim(shims, 'curl');
    return {
      root,
      script,
      log,
      env: { OPS_LOG: log, APP_DIR: root, PATH: `${shims}:/usr/bin:/bin` },
    };
  }

  it('restarts only the loaded web image for a preview tag', () => {
    const fixture = hostFixture('scripts/deploy-tk104-web.sh');
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, PANEL_IMAGE_TAG: RELEASE_SHA },
    });
    assert.equal(result.status, 0, result.stderr);
    const docker = logLines(fixture.log).filter((line) => line.startsWith('docker|'));
    assert.equal(docker[0], `docker|image|inspect|squad-panel/web:${RELEASE_SHA}`);
    assert.ok(
      docker.includes(
        'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|up|-d|--no-deps|web',
      ),
      docker.join('\n'),
    );
    assert.equal(
      docker.some((line) => line.includes('|build') || line.includes('--remove-orphans')),
      false,
    );
  });

  it('refuses a preview without a tag or with a missing image, before restarting web', () => {
    const untagged = hostFixture('scripts/deploy-tk104-web.sh');
    const noTag = run('/bin/bash', [untagged.script], { env: untagged.env });
    assert.equal(noTag.status, 1);
    assert.match(noTag.stderr, /PANEL_IMAGE_TAG must name the web image/);
    assert.deepEqual(logLines(untagged.log), []);

    const missing = hostFixture('scripts/deploy-tk104-web.sh');
    const noImage = run('/bin/bash', [missing.script], {
      env: {
        ...missing.env,
        PANEL_IMAGE_TAG: RELEASE_SHA,
        FAIL_DOCKER_MATCH: 'image inspect',
      },
    });
    assert.equal(noImage.status, 1);
    assert.match(noImage.stderr, /is not loaded/);
    assert.equal(
      logLines(missing.log).some((line) => line.includes('|up|')),
      false,
    );
  });

  it('builds the preview web image through the override when asked', () => {
    const fixture = hostFixture('scripts/deploy-tk104-web.sh');
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, PANEL_IMAGE_TAG: 'dev-abc1234', DEPLOY_BUILD: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      logLines(fixture.log)[0],
      'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|-f|compose.tk104.build.yml|build|web',
    );
  });

  function rollbackFixture(): {
    root: string;
    script: string;
    log: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/rollback-tk104.sh');
    const deployScript = path.join(root, 'scripts/deploy-tk104.sh');
    const log = path.join(root, 'commands.log');
    // The real deploy script is covered above; here only the hand-off matters.
    executable(
      deployScript,
      `printf 'deploy|%s|%s\\n' "$PANEL_IMAGE_TAG" "$APP_VERSION" >> "\${OPS_LOG:?}"`,
    );
    return { root, script, log, env: { OPS_LOG: log, APP_DIR: root } };
  }

  it('rolls back to the previous release through the normal deploy path', () => {
    const fixture = rollbackFixture();
    const previous = 'b'.repeat(40);
    writeFileSync(path.join(fixture.root, '.release'), `${RELEASE_SHA}\n`);
    writeFileSync(path.join(fixture.root, '.release.prev'), `${previous}\n`);
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(logLines(fixture.log), [`deploy|${previous}|${previous}`]);
  });

  it('refuses a rollback with no previous release or onto the running one', () => {
    const empty = rollbackFixture();
    const none = run('/bin/bash', [empty.script], { env: empty.env });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no previous release recorded/);

    const same = rollbackFixture();
    writeFileSync(path.join(same.root, '.release'), `${RELEASE_SHA}\n`);
    const onto = run('/bin/bash', [same.script], {
      env: { ...same.env, ROLLBACK_TO: RELEASE_SHA },
    });
    assert.equal(onto.status, 1);
    assert.match(onto.stderr, /already the running release/);
    assert.deepEqual(logLines(empty.log), []);
    assert.deepEqual(logLines(same.log), []);
  });
});

describe('fast developer deploy to tk104', () => {
  function devDeployFixture(): {
    root: string;
    script: string;
    log: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/dev-deploy-tk104.sh');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(shims, 'rsync', `exit "\${RSYNC_EXIT:-0}"`);
    loggingShim(shims, 'ssh', `exit "\${SSH_EXIT:-0}"`);
    // CURL_FAIL_TIMES models a rebuilt api answering 502 through Caddy while
    // it boots: the first N probes fail, every later one succeeds.
    loggingShim(
      shims,
      'curl',
      [
        `attempts_file="\${OPS_LOG:?}.dev-curl-attempts"`,
        'attempts=$(( $(cat "$attempts_file" 2>/dev/null || echo 0) + 1 ))',
        'printf "%s" "$attempts" > "$attempts_file"',
        `if [[ -n "\${CURL_FAIL_TIMES:-}" && "$attempts" -le "$CURL_FAIL_TIMES" ]]; then exit "\${CURL_EXIT:-22}"; fi`,
        `exit "\${CURL_PERSISTENT_EXIT:-0}"`,
      ].join('\n'),
    );
    loggingShim(shims, 'sleep');
    // `git` decides the version stamp; the shim keeps it deterministic and
    // lets a test flip the tree to dirty.
    loggingShim(
      shims,
      'git',
      [
        `if [[ "$*" == *'rev-parse'* ]]; then printf '%s\\n' "\${GIT_SHA:-abc1234}"; fi`,
        `if [[ "$*" == *'status --porcelain'* ]]; then printf '%s' "\${GIT_DIRTY:-}"; fi`,
        'exit 0',
      ].join('\n'),
    );
    return {
      root,
      script,
      log,
      env: { OPS_LOG: log, SOURCE_DIR: root, PATH: `${shims}:/usr/bin:/bin` },
    };
  }

  function sshPayload(log: string): string {
    return logLines(log)
      .filter((line) => line.startsWith('ssh|'))
      .map((line) => line.split('|').at(-1) ?? '')
      .join('\n');
  }

  it('defaults to the web service and rebuilds it on the host after the sync', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const commands = logLines(fixture.log);
    const rsyncIndex = commands.findIndex((line) => line.startsWith('rsync|'));
    const sshIndex = commands.findIndex((line) => line.startsWith('ssh|'));
    assert.ok(rsyncIndex >= 0 && sshIndex > rsyncIndex, commands.join('\n'));
    assert.match(sshPayload(fixture.log), /DEPLOY_BUILD=1 bash scripts\/deploy-tk104-web\.sh/);
    // Nothing that could touch the schema or other containers.
    assert.doesNotMatch(sshPayload(fixture.log), /deploy-tk104\.sh|migrator|--remove-orphans/);
  });

  it('never ships host secrets, state, or build output', () => {
    const fixture = devDeployFixture();
    run('/bin/bash', [fixture.script], { env: fixture.env });
    const rsync = logLines(fixture.log).find((line) => line.startsWith('rsync|')) ?? '';
    for (const excluded of ['.git', 'node_modules', '.next', 'data', 'dist', '.env', '.env.*']) {
      assert.ok(rsync.includes(`|--exclude|${excluded}`), `${excluded} is not excluded: ${rsync}`);
    }
    assert.ok(rsync.includes('|--delete'), rsync);
    assert.match(rsync, /\|seregatipich@tk104\.duckdns\.org:apps\/squad-admin-panel\/$/);
  });

  it('stamps a version that can never be mistaken for a released commit SHA', () => {
    const fixture = devDeployFixture();
    run('/bin/bash', [fixture.script], { env: { ...fixture.env, GIT_SHA: 'deadbee' } });
    assert.match(
      sshPayload(fixture.log),
      /APP_VERSION='dev-deadbee' PANEL_IMAGE_TAG='dev-deadbee'/,
    );

    const dirty = devDeployFixture();
    run('/bin/bash', [dirty.script], {
      env: { ...dirty.env, GIT_SHA: 'deadbee', GIT_DIRTY: ' M apps/web/src/page.tsx' },
    });
    assert.match(
      sshPayload(dirty.log),
      /APP_VERSION='dev-deadbee-dirty' PANEL_IMAGE_TAG='dev-deadbee-dirty'/,
    );
  });

  it('rebuilds only the api container, without the migrator, for the api target', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'api'], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = sshPayload(fixture.log);
    assert.match(payload, /-f compose\.tk104\.yml -f compose\.tk104\.build\.yml build api/);
    assert.match(payload, /up -d --no-deps api/);
    assert.doesNotMatch(payload, /migrator|--remove-orphans/);
  });

  it('refuses the full deploy without the explicit confirmation, before any sync', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'full'], { env: fixture.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /migrations from the working tree/);
    assert.deepEqual(logLines(fixture.log), []);
  });

  it('runs the full deploy script once the confirmation is exact', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'full'], {
      env: { ...fixture.env, CONFIRM_FULL_DEPLOY: 'deploy' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(sshPayload(fixture.log), /DEPLOY_BUILD=1 bash scripts\/deploy-tk104\.sh/);
  });

  it('rebuilds a single worker container by name, on the same no-deps path', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'worker-rcon'], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = sshPayload(fixture.log);
    assert.match(payload, /-f compose\.tk104\.build\.yml build worker-rcon/);
    assert.match(payload, /up -d --no-deps worker-rcon/);
    assert.doesNotMatch(payload, /migrator|--remove-orphans/);
  });

  it('rejects an unknown target before touching the production host', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'postgres'], { env: fixture.env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: dev-deploy-tk104\.sh \[web\|api\|worker-<name>\|full\]/);
    assert.deepEqual(logLines(fixture.log), []);
  });

  it('stops at a failed sync instead of rebuilding a half-copied tree', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script], {
      ...{},
      env: { ...fixture.env, RSYNC_EXIT: '23' },
    });
    assert.equal(result.status, 23);
    assert.deepEqual(
      logLines(fixture.log).filter((line) => line.startsWith('ssh|')),
      [],
    );
  });

  it('retries the health probe while the rebuilt api is still booting, then reports success', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'api'], {
      env: { ...fixture.env, CURL_FAIL_TIMES: '3' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Done\./);
    assert.equal(logLines(fixture.log).filter((line) => line.startsWith('curl|')).length, 4);
  });

  it('fails closed, preserving the curl exit code, when health never recovers', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'api'], {
      env: { ...fixture.env, CURL_PERSISTENT_EXIT: '22' },
    });
    assert.equal(result.status, 22);
    assert.match(result.stderr, /never recovered/);
    assert.doesNotMatch(result.stdout, /Done\./);
  });

  it('fails when the remote rebuild fails, without announcing success', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script], { env: { ...fixture.env, SSH_EXIT: '7' } });
    assert.equal(result.status, 7);
    assert.doesNotMatch(result.stdout, /Done\./);
  });
});

describe('rebuild confirmation, ordering, and stop-on-failure behavior', () => {
  function rebuildFixture(): {
    root: string;
    script: string;
    env: NodeJS.ProcessEnv;
    log: string;
  } {
    const { root, script } = copyScript('scripts/rebuild.sh');
    for (const subdirectory of [
      'postgres',
      'redis',
      'caddy-data',
      'caddy-config',
      'backup-repo',
      'backup-dump',
      'depot',
      'servers',
    ]) {
      const directory = path.join(root, 'data', subdirectory);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'sentinel'), subdirectory);
    }
    writeFileSync(path.join(root, '.env'), 'APP_DOMAIN=panel.test\nSECRET=preserved\n');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(shims, 'id', "printf '0\\n'; exit 0");
    loggingShim(
      shims,
      'docker',
      [
        `if [[ -n "\${FAIL_DOCKER_MATCH:-}" && "$*" == *"$FAIL_DOCKER_MATCH"* ]]; then exit "\${FAIL_CODE:-45}"; fi`,
        "if [[ \"$1\" == 'inspect' && \"$*\" == *'Health.Status'* ]]; then printf 'healthy\\n'; fi",
        "if [[ \"$1\" == 'inspect' && \"$*\" == *'.State.Status'* ]]; then printf 'exited\\n'; fi",
        "if [[ \"$1\" == 'inspect' && \"$*\" == *'.State.ExitCode'* ]]; then printf '0\\n'; fi",
        'exit 0',
      ].join('\n'),
    );
    loggingShim(
      shims,
      'rm',
      [
        'safe=1',
        'for argument in "$@"; do',
        `  if [[ "$argument" != -* && "$argument" != "\${OPS_SAFE_ROOT}"* ]]; then safe=0; fi`,
        'done',
        'if [[ "$safe" -eq 1 ]]; then exec /bin/rm "$@"; fi',
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'sleep');
    return {
      root,
      script,
      log,
      env: { OPS_LOG: log, OPS_SAFE_ROOT: root, PATH: `${shims}:/usr/bin:/bin` },
    };
  }

  it('does nothing when the exact destructive confirmation is absent', () => {
    const fixture = rebuildFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: fixture.env,
      input: 'no\n',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Aborted/);
    assert.equal(existsSync(path.join(fixture.root, 'data/postgres/sentinel')), true);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('docker|')),
      false,
    );
  });

  it('wipes only fixture data, preserves secrets, rebuilds, then starts', () => {
    const fixture = rebuildFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: fixture.env,
      input: 'rebuild\n',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const subdirectory of [
      'postgres',
      'redis',
      'caddy-data',
      'caddy-config',
      'backup-repo',
      'backup-dump',
      'depot',
    ]) {
      assert.equal(existsSync(path.join(fixture.root, 'data', subdirectory)), true);
      assert.equal(existsSync(path.join(fixture.root, 'data', subdirectory, 'sentinel')), false);
    }
    assert.equal(existsSync(path.join(fixture.root, 'data/servers/sentinel')), false);
    assert.equal(
      readFileSync(path.join(fixture.root, '.env'), 'utf8'),
      'APP_DOMAIN=panel.test\nSECRET=preserved\n',
    );
    assert.deepEqual(
      logLines(fixture.log).filter((line) => line.startsWith('docker|compose|')),
      [
        'docker|compose|down|--remove-orphans',
        'docker|compose|down|-v',
        'docker|compose|build|--no-cache|--progress=plain',
        'docker|compose|up|-d',
      ],
    );
  });

  it('propagates image-build failure and never starts a partial stack', () => {
    const fixture = rebuildFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, FAIL_DOCKER_MATCH: 'compose build', FAIL_CODE: '46' },
      input: 'rebuild\n',
    });
    assert.equal(result.status, 46);
    assert.equal(
      logLines(fixture.log).some((line) => line === 'docker|compose|up|-d'),
      false,
    );
  });
});

describe('uninstall safety and cleanup boundaries', () => {
  function uninstallFixture(): {
    root: string;
    script: string;
    env: NodeJS.ProcessEnv;
    log: string;
  } {
    const { root, script } = copyScript('scripts/uninstall.sh');
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data/sentinel'), 'safe temporary data');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(shims, 'id', "printf '0\\n'; exit 0");
    loggingShim(
      shims,
      'systemctl',
      `if [[ -n "\${FAIL_SYSTEMCTL_MATCH:-}" && "$*" == *"$FAIL_SYSTEMCTL_MATCH"* ]]; then exit "\${FAIL_CODE:-48}"; fi; exit 0`,
    );
    loggingShim(
      shims,
      'rm',
      [
        'safe=1',
        'for argument in "$@"; do',
        `  if [[ "$argument" != -* && "$argument" != "\${OPS_SAFE_ROOT}"* ]]; then safe=0; fi`,
        'done',
        'if [[ "$safe" -eq 1 ]]; then exec /bin/rm "$@"; fi',
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'docker');
    loggingShim(shims, 'groupdel');
    return {
      root,
      script,
      log,
      env: { OPS_LOG: log, OPS_SAFE_ROOT: root, PATH: `${shims}:/usr/bin:/bin` },
    };
  }

  it('executes confirmed cleanup in order while remapping host mutations', () => {
    const fixture = uninstallFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: fixture.env,
      input: 'y\ny\ny\ny\ny\n',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(fixture.root, 'data')), false);
    const commands = logLines(fixture.log);
    assert.ok(
      commands.indexOf('systemctl|daemon-reload') <
        commands.findIndex((line) => line.startsWith('docker|volume|rm')),
    );
    assert.ok(
      commands.findIndex((line) => line.startsWith('docker|volume|rm')) <
        commands.indexOf(`rm|-rf|${path.join(fixture.root, 'data')}`),
    );
    assert.equal(commands.at(-1), 'groupdel|panel');
  });

  it('stops at daemon-reload failure and leaves later resources untouched', () => {
    const fixture = uninstallFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, FAIL_SYSTEMCTL_MATCH: 'daemon-reload', FAIL_CODE: '48' },
      input: 'y\ny\ny\ny\ny\n',
    });
    assert.equal(result.status, 48);
    const commands = logLines(fixture.log);
    assert.equal(
      commands.some((line) => line.startsWith('docker|')),
      false,
    );
    assert.equal(
      commands.some((line) => line === `rm|-rf|${path.join(fixture.root, 'data')}`),
      false,
    );
    assert.equal(existsSync(path.join(fixture.root, 'data/sentinel')), true);
  });
});

describe('verify-bridge framed Unix-socket smoke test', () => {
  async function bridgeServer(
    socketPath: string,
    closeOnMethod?: string,
  ): Promise<{ server: net.Server; requests: Array<Record<string, unknown>> }> {
    const requests: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const size = buffer.readUInt32BE(0);
        if (buffer.length < size + 4) return;
        const request = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')) as Record<
          string,
          unknown
        >;
        requests.push(request);
        if (request.method === closeOnMethod) {
          socket.end();
          return;
        }
        const payload = Buffer.from(
          JSON.stringify({ id: request.id, ok: true, result: { method: request.method } }),
        );
        const frame = Buffer.alloc(payload.length + 4);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        socket.end(frame);
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    return { server, requests };
  }

  it('fails before Python when the configured socket does not exist', () => {
    const missing = path.join(temporaryRoot('missing-bridge-socket'), 'bridge.sock');
    const result = run('/bin/bash', [path.join(REPOSITORY_ROOT, 'scripts/verify-bridge.sh')], {
      env: { BRIDGE_SOCKET: missing },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /socket .* not found/);
  });

  it('sends all eight exact method and parameter frames through a temporary socket', async () => {
    const socketPath = path.join(temporaryRoot('verify-bridge'), 'bridge.sock');
    const fixture = await bridgeServer(socketPath);
    try {
      const result = await runAsync(
        '/bin/bash',
        [path.join(REPOSITORY_ROOT, 'scripts/verify-bridge.sh')],
        { env: { BRIDGE_SOCKET: socketPath } },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[verify-bridge\].*done/);
      assert.deepEqual(
        fixture.requests.map((request) => request.method),
        [
          'ping',
          'host_info',
          'host_metrics',
          'process_info',
          'file_read',
          'file_atomic_write',
          'container_inspect',
          'container_run',
        ],
      );
      const processId = (fixture.requests[3]?.params as { pid?: number }).pid;
      assert.equal(Number.isInteger(processId) && (processId ?? 0) > 0, true);
      assert.deepEqual(fixture.requests[4]?.params, { path: '/etc/shadow' });
      assert.deepEqual(fixture.requests[5]?.params, {
        path: '/opt/squad-servers/verify-bridge.tmp',
        content: 'verify-bridge ok\n',
        mode: 420,
      });
      assert.deepEqual(fixture.requests[7]?.params, {
        name: 'squad-00000000-0000-0000-0000-000000000000',
        image: 'alpine:latest',
        networkMode: 'host',
      });
    } finally {
      fixture.server.close();
      await once(fixture.server, 'close');
    }
  });

  it('propagates a missing response and sends no calls after the failed boundary', async () => {
    const socketPath = path.join(temporaryRoot('verify-bridge-failure'), 'bridge.sock');
    const fixture = await bridgeServer(socketPath, 'host_metrics');
    try {
      const result = await runAsync(
        '/bin/bash',
        [path.join(REPOSITORY_ROOT, 'scripts/verify-bridge.sh')],
        { env: { BRIDGE_SOCKET: socketPath } },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /\(no response\)/);
      assert.deepEqual(
        fixture.requests.map((request) => request.method),
        ['ping', 'host_info', 'host_metrics'],
      );
    } finally {
      fixture.server.close();
      await once(fixture.server, 'close');
    }
  });
});

/**
 * Regression cover for #291: `scripts/test-backup-restore.sh`'s `wait_pg`
 * returned as soon as a single socket-based `pg_isready` succeeded, which the
 * postgres image's TEMPORARY init server satisfies. The socket then vanishes
 * during the handover to the real server and the seeding psql fails with
 * "No such file or directory".
 *
 * `wait_pg` is extracted from the real script (so the test cannot drift from
 * it) and exercised against a stub `docker` that reproduces the two-phase
 * startup: a socket-only temporary server first, the real server after.
 */
function waitPgHarness(phases: string): { script: string; log: string; env: NodeJS.ProcessEnv } {
  const source = readFileSync(path.join(REPOSITORY_ROOT, 'scripts/test-backup-restore.sh'), 'utf8');
  const readyVars = source.match(/^PG_READY_ATTEMPTS=.*\nPG_READY_STREAK=.*$/m)?.[0] ?? '';
  const waitPg = source.match(/^wait_pg\(\) \{[\s\S]*?^\}$/m)?.[0];
  assert.ok(waitPg, 'could not extract wait_pg() from scripts/test-backup-restore.sh');

  const root = temporaryRoot('wait-pg');
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, 'ops.log');
  writeFileSync(log, '');

  // Stub docker: `phases` decides, per invocation, whether the TCP probe
  // succeeds. Every invocation is logged so the test can count probes.
  executable(
    path.join(bin, 'docker'),
    [
      'printf "docker" >> "${OPS_LOG:?}"',
      'for argument in "$@"; do printf "|%s" "$argument" >> "${OPS_LOG:?}"; done',
      'printf "\\n" >> "${OPS_LOG:?}"',
      'count=$(grep -c . "${OPS_LOG:?}")',
      phases,
    ].join('\n'),
  );
  // Keep the test fast: the real script sleeps 1s per attempt.
  executable(path.join(bin, 'sleep'), 'exit 0');

  const script = path.join(root, 'harness.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'fail() { echo "FAIL: $*" >&2; exit 9; }',
      readyVars,
      waitPg,
      'wait_pg pg-source && echo "PG-READY"',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { script, log, env: { OPS_LOG: log, PATH: `${bin}:${process.env.PATH ?? ''}` } };
}

describe('backup-restore postgres readiness (#291)', () => {
  it('does not accept the socket-only temporary init server as ready', () => {
    // The temporary server answers for the first 5 probes, then the real
    // server takes over. A single-sample wait would return during that window.
    const fixture = waitPgHarness('if [ "$count" -le 5 ]; then exit 2; fi\nexit 0');
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PG-READY/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('docker|'));
    assert.ok(
      probes.length > 5,
      `expected wait_pg to keep probing past the temporary server, got ${probes.length}`,
    );
    // Every probe must go over TCP — the discriminator the temporary server
    // (started with listen_addresses='') can never satisfy.
    for (const probe of probes) {
      assert.match(probe, /\|-h\|127\.0\.0\.1\|/, `probe did not use TCP: ${probe}`);
    }
  });

  it('requires consecutive successes, so a momentary window is not enough', () => {
    // Succeed once, then fail again: a streak-of-1 implementation would return.
    const fixture = waitPgHarness(
      'if [ "$count" -eq 2 ] || [ "$count" -ge 12 ]; then exit 0; fi\nexit 2',
    );
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });

    assert.equal(result.status, 0, result.stderr);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('docker|'));
    assert.ok(
      probes.length >= 12,
      `a single lucky probe must not satisfy wait_pg, got ${probes.length}`,
    );
  });

  it('fails closed when postgres never becomes ready', () => {
    const fixture = waitPgHarness('exit 2');
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, PG_READY_ATTEMPTS: '7' },
    });

    assert.equal(result.status, 9);
    assert.match(result.stderr, /never became stably ready over TCP/);
    assert.doesNotMatch(result.stdout, /PG-READY/);
    assert.equal(
      logLines(fixture.log).filter((line) => line.startsWith('docker|')).length,
      7,
      'expected the attempt budget to be honoured',
    );
  });
});
