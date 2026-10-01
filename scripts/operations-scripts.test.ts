import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const OPERATIONS_SCRIPTS = [
  'scripts/bootstrap.sh',
  'scripts/deploy-stand.sh',
  'scripts/rollback-stand.sh',
  'scripts/deploy-entry.sh',
  'scripts/install-host-bridge.sh',
  'scripts/rebuild.sh',
  'scripts/restore.sh',
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

// Git exports these to its hooks, so under the pre-push checklist they name
// this repository; a child that runs git in a fixture repository would then
// operate on this one instead ("this operation must be run in a work tree").
const GIT_LOCATION_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

function childEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of GIT_LOCATION_VARIABLES) delete inherited[name];
  return { ...inherited, ...overrides };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: childEnvironment(options.env),
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
    env: childEnvironment(options.env),
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
      'scripts/deploy-workflow.test.ts',
      'scripts/operations-scripts.test.ts',
      'scripts/verify-audit-chain.test.ts',
    ]) {
      assert.match(testScripts, new RegExp(testFile.replaceAll('.', '\\.')));
    }

    const workflow = readFileSync(path.join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8');
    // Scoped to the `scripts` job: other jobs migrate too, and a match there
    // would hide a scripts job that runs its contracts against an empty schema.
    const jobStart = workflow.indexOf('\n  scripts:\n');
    assert.ok(jobStart >= 0, 'ci.yml has no scripts job');
    const jobEnd = workflow.slice(jobStart + 1).search(/\n {2}[a-z0-9-]+:\n/u);
    const scriptsJob =
      jobEnd < 0 ? workflow.slice(jobStart) : workflow.slice(jobStart, jobStart + 1 + jobEnd);
    const migrations = scriptsJob.indexOf('name: Apply database migrations');
    const scriptTests = scriptsJob.indexOf('name: Run operations and verification script tests');
    assert.ok(migrations >= 0 && scriptTests > migrations);
    assert.match(scriptsJob.slice(migrations), /\n {8}run: pnpm --filter @squad\/db migrate\n/u);
    assert.match(scriptsJob.slice(scriptTests), /\n {8}run: pnpm test:scripts\n/u);
    // test:scripts builds the one package its contracts load; a full Turbo
    // build here only spends CI minutes.
    assert.doesNotMatch(scriptsJob, /turbo run build/u);
  });
});

describe('local pre-push checklist and git hooks', () => {
  // The checklist probes an exported DATABASE_URL before trusting it, so the
  // URLs handed to it must name something that accepts connections.
  const database = net.createServer((socket) => socket.destroy());
  let databaseUrl = '';
  before(async () => {
    database.listen(0, '127.0.0.1');
    await once(database, 'listening');
    databaseUrl = `postgres://admin@127.0.0.1:${(database.address() as net.AddressInfo).port}`;
  });
  after(() => {
    database.close();
  });

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
        '  "turbo run test "*) printf \'%s|%s\\n\' "${DATABASE_URL:-}" "${TEST_DATABASE_URL:-}" >> "$DB_ENV_LOG" ;;',
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
      /** Native pre-push lines lefthook would pipe in; empty for a manual run. */
      input?: string;
    } = {},
  ): CommandResult {
    const items = options.packages ?? [];
    return run('/bin/bash', [fixture.script], {
      cwd: fixture.root,
      input: options.input,
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
        DATABASE_URL: `${databaseUrl}/isolated-test-database`,
        TEST_DATABASE_URL: `${databaseUrl}/isolated-test-database`,
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

  describe('which pushes are gated', () => {
    const pushLine = (remoteRef: string) =>
      `refs/heads/work ${MERGE_BASE} ${remoteRef} ${'0'.repeat(40)}\n`;
    const gatedCommands = (fixture: ChecklistFixture) => checklistCommands(fixture);

    it('runs for a push that updates dev', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, { input: pushLine('refs/heads/dev') });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(gatedCommands(fixture).length > 0, 'the dev push must run the checklist');
    });

    it('skips a work-branch push, which deploys nothing', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, { input: pushLine('refs/heads/feature/x') });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /skipped — this push does not update dev/);
      assert.deepEqual(gatedCommands(fixture), []);
    });

    it('skips the dev→master promotion, whose tip the dev push already passed', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, { input: pushLine('refs/heads/master') });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(gatedCommands(fixture), []);
    });

    it('runs when one of several pushed refs is dev', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, {
        input: pushLine('refs/heads/feature/x') + pushLine('refs/heads/dev'),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(gatedCommands(fixture).length > 0);
    });

    it('runs FULL=1 whatever is pushed', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      runChecklist(fixture, { input: pushLine('refs/heads/master'), env: { FULL: '1' } });
      assert.ok(gatedCommands(fixture).length > 0);
    });
  });

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
      'gitleaks|git|--config|.github/gitleaks.toml|--no-banner|--redact|--exit-code|1|--log-opts|origin/dev..HEAD',
      `pnpm|-s|turbo|ls|--filter=[${MERGE_BASE}]|--output=json`,
      `pnpm|turbo|run|typecheck|--filter=...[${MERGE_BASE}]`,
      'pnpm|turbo|run|test|--concurrency=2|--filter=@fixture/plain|--filter=@fixture/db-worker',
      'pnpm|--filter|@squad/api|exec|vitest|run|--passWithNoTests|test/players.test.ts|test/e2e/install-lifecycle.e2e.test.ts|test/integration/new-route.test.ts',
      'pnpm|test:scripts',
    ]);
    assert.deepEqual(logLines(fixture.dbEnvLog), [
      `${databaseUrl}/isolated-test-database|${databaseUrl}/isolated-test-database`,
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
      env: { DATABASE_URL: `${databaseUrl}/exported`, TEST_DATABASE_URL: '' },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(logLines(fixture.dbEnvLog), [
      `${databaseUrl}/exported|${databaseUrl}/exported`,
    ]);
  });

  it('skips the DB-backed suites instead of hanging when the exported database does not answer', async () => {
    const closed = net.createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const { port } = closed.address() as net.AddressInfo;
    closed.close();
    await once(closed, 'close');

    const fixture = checklistFixture(FIXTURE_PACKAGES);
    const result = runChecklist(fixture, {
      packages: [DB_PACKAGE, PLAIN_PACKAGE],
      changed: ['apps/workers/db-worker/src/tick.ts', 'packages/plain/src/index.ts'],
      env: {
        DATABASE_URL: `postgres://admin@127.0.0.1:${port}/stopped`,
        TEST_DATABASE_URL: `postgres://admin@127.0.0.1:${port}/stopped`,
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /exported DATABASE_URL does not answer/);
    assert.match(
      result.stdout,
      /DB-backed package tests — skipped \(no database: @fixture\/db-worker\)/,
    );
    assert.deepEqual(logLines(fixture.dbEnvLog), ['|']);
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
      changed: ['scripts/deploy-stand.sh'],
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
      'gitleaks|git|--config|.github/gitleaks.toml|--no-banner|--redact|--exit-code|1|--log-opts|origin/dev..HEAD',
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
      'gitleaks|git|--config|.github/gitleaks.toml|--no-banner|--redact|--exit-code|1|--log-opts|origin/dev..HEAD',
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
        'gitleaks|protect|--staged|--config|.github/gitleaks.toml|--no-banner|--redact',
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

  it('install-host-bridge provisions every bind-mounted data directory, media included', () => {
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
    // Every host mutation is logged, never performed; the data-tree mkdir is
    // the last step this test needs, so it ends the run there.
    loggingShim(shims, 'mkdir', `if [[ "$*" == *'/data/postgres'* ]]; then exit 44; fi; exit 0`);
    for (const command of ['chown', 'chmod', 'install', 'systemctl', 'systemd-tmpfiles', 'rm']) {
      loggingShim(shims, command);
    }
    const result = run('/bin/bash', [script], {
      env: { OPS_LOG: log, PATH: `${shims}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 44, result.stderr);
    const dataTree = logLines(log).find((line) => line.includes('/data/postgres'));
    assert.ok(dataTree, 'the data-tree mkdir never ran');
    const created = dataTree.split('|').slice(2);
    for (const subdirectory of [
      'postgres',
      'redis',
      'caddy-data',
      'caddy-config',
      'backup-repo',
      'backup-dump',
      'depot',
      'media',
    ]) {
      assert.ok(created.includes(path.join(root, 'data', subdirectory)), `missing ${subdirectory}`);
    }
  });

  it('every bind-mounted DATA_DIR path in docker/compose.yml is provisioned, checked and rebuilt', () => {
    const compose = readFileSync(path.join(REPOSITORY_ROOT, 'docker/compose.yml'), 'utf8');
    const devices = [...compose.matchAll(/device: \$\{DATA_DIR\}\/([a-z0-9-]+)/g)].map(
      (match) => match[1] as string,
    );
    assert.ok(devices.includes('media'), devices.join(','));
    const installer = readFileSync(
      path.join(REPOSITORY_ROOT, 'scripts/install-host-bridge.sh'),
      'utf8',
    );
    const bootstrap = readFileSync(path.join(REPOSITORY_ROOT, 'scripts/bootstrap.sh'), 'utf8');
    const rebuild = readFileSync(path.join(REPOSITORY_ROOT, 'scripts/rebuild.sh'), 'utf8');
    const inventory = bootstrap.match(/^for sub in ([^;]+); do$/m)?.[1]?.split(' ') ?? [];
    const rebuilt = rebuild.match(/^for sub in ([^;]+); do$/m)?.[1]?.split(' ') ?? [];
    for (const device of devices) {
      assert.match(installer, new RegExp(`"\\$\\{DATA_DIR\\}/${device}"`), `installer: ${device}`);
      assert.ok(inventory.includes(device), `bootstrap inventory: ${device}`);
      assert.ok(rebuilt.includes(device), `rebuild: ${device}`);
    }
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

const IMAGE_REPO = 'ghcr.io/seregatipich/squad-panel';
const RELEASE_SHA = 'a'.repeat(40);
const NEXT_SHA = 'c'.repeat(40);
const IMAGES = [
  ['API_IMAGE', 'api'],
  ['WEB_IMAGE', 'web'],
  ['WORKERS_IMAGE', 'workers'],
  ['CADDY_IMAGE', 'caddy'],
] as const;
type ImageKey = (typeof IMAGES)[number][0];

function imageRef(name: string, fill: string): string {
  return `${IMAGE_REPO}-${name}@sha256:${fill.repeat(64)}`;
}

/** The four image variables of a release, each digest filled with `fill` unless overridden. */
function releaseImages(
  fill = '1',
  overrides: Partial<Record<ImageKey, string>> = {},
): Record<ImageKey, string> {
  return Object.fromEntries(
    IMAGES.map(([key, name]) => [key, overrides[key] ?? imageRef(name, fill)]),
  ) as Record<ImageKey, string>;
}

/**
 * Stand-ins for the host's tools. `docker` answers the handful of queries the
 * deploy makes: `compose ps -a` reports DOCKER_IDS_BEFORE until `up -d
 * --remove-orphans` has run and DOCKER_IDS_AFTER afterwards (a changed ID is a
 * recreated container), `compose ps` reports DOCKER_HEALTH, `image inspect`
 * succeeds only for references in DOCKER_PRESENT, and `image ls <repo>` lists
 * the IDs in DOCKER_REPO_IDS that belong to <repo>. `curl` answers /health with
 * the APP_VERSION the deploy is rolling out, as the recreated api would.
 */
function hostShims(): string {
  const shims = shimDirectory();
  loggingShim(
    shims,
    'docker',
    [
      `last="\${@: -1}"`,
      `if [[ "$*" == 'compose version --short' ]]; then printf '%s\\n' "\${DOCKER_COMPOSE_VERSION-2.29.7}"; exit 0; fi`,
      `if [[ -n "\${FAIL_DOCKER_MATCH:-}" && "$*" == *"$FAIL_DOCKER_MATCH"* ]]; then exit "\${FAIL_CODE:-41}"; fi`,
      `ids='postgres p1,redis r1,api a1,web w1,caddy c1,worker-rcon k1'`,
      `health='postgres running healthy,redis running healthy,api running healthy,web running healthy,caddy running ,worker-rcon running '`,
      'case "$*" in',
      `  *'ps -a --format'*)`,
      `    if grep -qF '|up|-d|--remove-orphans' "$OPS_LOG"; then ids="\${DOCKER_IDS_AFTER:-$ids}"; else ids="\${DOCKER_IDS_BEFORE:-$ids}"; fi`,
      `    printf '%s\\n' "$ids" | tr ',' '\\n' ;;`,
      `  *'ps --format'*) printf '%s\\n' "\${DOCKER_HEALTH:-$health}" | tr ',' '\\n' ;;`,
      `  *pg_dump*) printf 'PGDMP' ;;`,
      `  'image inspect'*)`,
      `    case ",\${DOCKER_PRESENT:-}," in *",$last,"*) ;; *) exit 1 ;; esac`,
      `    if [[ "$*" == *--format* ]]; then printf 'id:%s\\n' "$last"; fi ;;`,
      `  'image ls'*)`,
      `    for id in \${DOCKER_REPO_IDS//,/ }; do if [[ "$id" == "id:$last"[@:]* ]]; then printf '%s\\n' "$id"; fi; done ;;`,
      'esac',
      'exit 0',
    ].join('\n'),
  );
  loggingShim(shims, 'sleep');
  // CURL_FAIL_TIMES makes the first N probes fail with CURL_EXIT and every
  // later one succeed, modelling caddy finishing its TLS handshake mid-deploy;
  // CURL_EXIT alone fails every probe.
  loggingShim(
    shims,
    'curl',
    [
      `attempts_file="\${OPS_LOG:?}.curl-attempts"`,
      'attempts=$(( $(cat "$attempts_file" 2>/dev/null || echo 0) + 1 ))',
      'printf "%s" "$attempts" > "$attempts_file"',
      `if [[ -n "\${CURL_FAIL_TIMES:-}" ]]; then`,
      `  if [[ "$attempts" -le "$CURL_FAIL_TIMES" ]]; then exit "\${CURL_EXIT:-35}"; fi`,
      `elif [[ -n "\${CURL_EXIT:-}" ]]; then exit "$CURL_EXIT"; fi`,
      `version="\${CURL_VERSION:-$(sed -n 's/^APP_VERSION=//p' "$APP_DIR/.release.next.env" 2>/dev/null)}"`,
      `printf '{"status":"ok","uptime_s":1,"version":"%s"}' "$version"`,
    ].join('\n'),
  );
  // Linux has sha256sum on the test PATH; macOS keeps it in /sbin (14+) or
  // only offers shasum.
  if (!existsSync('/usr/bin/sha256sum') && !existsSync('/bin/sha256sum')) {
    if (existsSync('/sbin/sha256sum')) {
      symlinkSync('/sbin/sha256sum', path.join(shims, 'sha256sum'));
    } else {
      executable(path.join(shims, 'sha256sum'), 'exec /usr/bin/shasum -a 256 "$@"');
    }
  }
  return shims;
}

interface DeployFixture {
  root: string;
  script: string;
  log: string;
  backups: string;
  env: NodeJS.ProcessEnv;
}

/** An app directory with the files the deploy hashes, and host tool shims. */
function deployFixture(): DeployFixture {
  const { root, script } = copyScript('scripts/deploy-stand.sh');
  writeFileSync(
    path.join(root, '.env.stand'),
    'SAFE_TEST_VALUE=1\nAPP_DOMAIN=stand.example\nACME_EMAIL=ops@stand.example\nDUCKDNS_TOKEN=token-value\n',
  );
  mkdirSync(path.join(root, 'docker'));
  writeFileSync(path.join(root, 'docker/compose.stand.yml'), 'services: {}\n');
  writeFileSync(path.join(root, 'docker/Caddyfile.stand'), '{$APP_DOMAIN} {}\n');
  mkdirSync(path.join(root, 'packages/db/drizzle/meta'), { recursive: true });
  writeFileSync(path.join(root, 'packages/db/drizzle/0000_init.sql'), 'CREATE TABLE t ();\n');
  writeFileSync(path.join(root, 'packages/db/drizzle/meta/_journal.json'), '{"entries":[]}\n');
  const log = path.join(root, 'commands.log');
  const backups = path.join(root, 'backups');
  return {
    root,
    script,
    log,
    backups,
    env: {
      OPS_LOG: log,
      APP_DIR: root,
      BACKUP_DIR: backups,
      HEALTH_TIMEOUT: '3',
      PATH: `${hostShims()}:/usr/bin:/bin`,
      RELEASE_SHA,
      ...releaseImages(),
    },
  };
}

/** Runs one deploy with a fresh command log, as each deploy is its own SSH session. */
function deploy(
  fixture: DeployFixture,
  env: NodeJS.ProcessEnv = {},
  script = fixture.script,
): Promise<CommandResult> {
  rmSync(fixture.log, { force: true });
  rmSync(`${fixture.log}.curl-attempts`, { force: true });
  return runAsync('/bin/bash', [script], { env: { ...fixture.env, ...env } });
}

function releaseFile(fixture: DeployFixture, name = '.release.env'): Record<string, string> {
  const entries = readFileSync(path.join(fixture.root, name), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
  return Object.fromEntries(entries);
}

function dockerCommands(log: string): string[] {
  return logLines(log).filter((line) => line.startsWith('docker|'));
}

const COMPOSE =
  'docker|compose|--env-file|.env.stand|--env-file|.release.next.env|-f|docker/compose.stand.yml';

describe('the stand host release deploy', { concurrency: true }, () => {
  it('fails before Docker when the deployment environment file is absent', async () => {
    const { root, script } = copyScript('scripts/deploy-stand.sh');
    const result = await runAsync('/bin/bash', [script], { env: { APP_DIR: root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.stand is missing/);
  });

  it('refuses a malformed release or image reference before any Docker call', async () => {
    const fixture = deployFixture();
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ RELEASE_SHA: '' }, /RELEASE_SHA must name the release/],
      [{ RELEASE_SHA: 'bad sha' }, /RELEASE_SHA must name the release/],
      [{ RELEASE_SHA: '-leading-dash' }, /RELEASE_SHA must name the release/],
      [{ API_IMAGE: '' }, /API_IMAGE must be an image reference/],
      [{ WEB_IMAGE: `${IMAGE_REPO}-web` }, /WEB_IMAGE must be an image reference/],
      [{ WORKERS_IMAGE: `${IMAGE_REPO}-workers@sha256:abc` }, /WORKERS_IMAGE must be/],
      [{ CADDY_IMAGE: `$(touch ${fixture.root}/pwned)@sha256:${'1'.repeat(64)}` }, /CADDY_IMAGE/],
      [{ API_IMAGE: `GHCR.IO/x/api@sha256:${'1'.repeat(64)}` }, /API_IMAGE must be/],
    ];
    for (const [env, message] of cases) {
      const result = await deploy(fixture, env);
      assert.equal(result.status, 1, JSON.stringify(env));
      assert.match(result.stderr, message);
      assert.deepEqual(logLines(fixture.log), [], JSON.stringify(env));
    }
    assert.equal(existsSync(path.join(fixture.root, 'pwned')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it("refuses to start without the stand's APP_DOMAIN in .env.stand", async () => {
    for (const content of ['SAFE_TEST_VALUE=1\n', 'APP_DOMAIN=stand.example;id\n']) {
      const fixture = deployFixture();
      writeFileSync(path.join(fixture.root, '.env.stand'), content);
      const result = await deploy(fixture);
      assert.equal(result.status, 1, content);
      assert.match(result.stderr, /APP_DOMAIN in .*\.env\.stand must be the stand's host name/);
      assert.deepEqual(logLines(fixture.log), [], content);
    }
  });

  it('generates missing Redis secrets into .env.stand once and never rotates them', async () => {
    const fixture = deployFixture();
    const envFile = path.join(fixture.root, '.env.stand');
    writeFileSync(
      envFile,
      'SAFE_TEST_VALUE=1\nREDIS_SIDECAR_PASSWORD=\nACME_EMAIL=ops@stand.example\nDUCKDNS_TOKEN=token-value\nAPP_DOMAIN=stand.example',
    );
    const secrets = () =>
      Object.fromEntries(
        readFileSync(envFile, 'utf8')
          .split('\n')
          .filter((line) => /^REDIS_(SIDECAR_)?PASSWORD=/.test(line))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
    const env = { DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a2,web w2,caddy c2,worker-rcon k2' };

    const first = await deploy(fixture, env);
    assert.equal(first.status, 0, first.stderr);
    const generated = secrets();
    assert.match(generated.REDIS_PASSWORD ?? '', /^[0-9a-f]{64}$/);
    assert.match(generated.REDIS_SIDECAR_PASSWORD ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(generated.REDIS_PASSWORD, generated.REDIS_SIDECAR_PASSWORD);
    const lines = readFileSync(envFile, 'utf8').split('\n');
    assert.ok(lines.includes('APP_DOMAIN=stand.example'), 'the last line kept its value');
    assert.equal(lines.filter((line) => line.startsWith('REDIS_SIDECAR_PASSWORD=')).length, 1);

    const second = await deploy(fixture, env);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(secrets(), generated);
    assert.doesNotMatch(second.stdout, /generated REDIS/);
  });

  it('refuses to start without a real ACME_EMAIL and a DUCKDNS_TOKEN in .env.stand', async () => {
    const base = 'APP_DOMAIN=stand.example\n';
    const cases: Array<[string, RegExp]> = [
      [`${base}DUCKDNS_TOKEN=t\n`, /ACME_EMAIL in .*\.env\.stand must be set/],
      [`${base}ACME_EMAIL=ops@stand.example\n`, /DUCKDNS_TOKEN in .*\.env\.stand must be set/],
      [
        `${base}ACME_EMAIL=admin@example.com\nDUCKDNS_TOKEN=t\n`,
        /ACME_EMAIL .* must be a real address/,
      ],
    ];
    for (const [content, message] of cases) {
      const fixture = deployFixture();
      writeFileSync(path.join(fixture.root, '.env.stand'), content);
      const result = await deploy(fixture);
      assert.equal(result.status, 1, content);
      assert.match(result.stderr, message);
      assert.deepEqual(logLines(fixture.log), [], content);
    }
  });

  it('refuses a Compose too old to merge both env files, before changing anything', async () => {
    for (const version of ['2.16.0', 'v1.29.2', '']) {
      const fixture = deployFixture();
      const result = await deploy(fixture, { DOCKER_COMPOSE_VERSION: version });
      assert.equal(result.status, 1, version);
      assert.match(result.stderr, /Docker Compose 2\.17\+ is required/);
      assert.deepEqual(logLines(fixture.log), ['docker|compose|version|--short']);
      assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
    }
  });

  it('first release: pulls every image, backs up and migrates, starts, waits, records', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, {
      DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a2,web w2,caddy c2,worker-rcon k2',
    });
    assert.equal(result.status, 0, result.stderr);
    const images = releaseImages();
    assert.deepEqual(dockerCommands(fixture.log), [
      'docker|compose|version|--short',
      ...IMAGES.flatMap(([key]) => [
        `docker|image|inspect|${images[key]}`,
        `docker|pull|--quiet|${images[key]}`,
      ]),
      `${COMPOSE}|up|-d|postgres`,
      `${COMPOSE}|ps|--format|{{.Service}} {{.State}} {{.Health}}`,
      `${COMPOSE}|exec|-T|postgres|pg_dump|-U|admin|-d|admin|-Fc`,
      `${COMPOSE}|run|--rm|-T|migrator`,
      `${COMPOSE}|ps|-a|--format|{{.Service}} {{.ID}}`,
      `${COMPOSE}|up|-d|--remove-orphans`,
      `${COMPOSE}|ps|-a|--format|{{.Service}} {{.ID}}`,
      `${COMPOSE}|ps|--format|{{.Service}} {{.State}} {{.Health}}`,
      `${COMPOSE}|ps`,
      ...IMAGES.map(([key]) => `docker|image|inspect|--format|{{.Id}}|${images[key]}`),
      ...IMAGES.map(([, name]) => `docker|image|ls|--quiet|--no-trunc|${IMAGE_REPO}-${name}`),
    ]);
    assert.equal(
      logLines(fixture.log).some((line) => line.includes('|build')),
      false,
    );
    assert.match(result.stdout, /Recreated: api caddy web worker-rcon/);
    assert.match(result.stdout, new RegExp(`${RELEASE_SHA} is live`));

    const recorded = releaseFile(fixture);
    assert.deepEqual(Object.keys(recorded), [
      'RELEASE_SHA',
      'APP_VERSION',
      'API_IMAGE',
      'WEB_IMAGE',
      'WORKERS_IMAGE',
      'CADDY_IMAGE',
      'CADDYFILE_SHA',
      'MIGRATIONS_SHA',
      'COMPOSE_CONFIG_SHA',
    ]);
    assert.equal(recorded.RELEASE_SHA, RELEASE_SHA);
    assert.equal(recorded.APP_VERSION, RELEASE_SHA);
    for (const [key] of IMAGES) assert.equal(recorded[key], images[key]);
    for (const key of ['CADDYFILE_SHA', 'MIGRATIONS_SHA', 'COMPOSE_CONFIG_SHA']) {
      assert.match(recorded[key] ?? '', /^[0-9a-f]{64}$/, key);
    }
    assert.equal(existsSync(path.join(fixture.root, '.release.prev.env')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
    const dumps = readdirSync(fixture.backups);
    assert.equal(dumps.length, 1);
    assert.match(dumps[0] ?? '', /^panel-\d{8}T\d{6}Z-a{12}\.dump$/);
    assert.equal(readFileSync(path.join(fixture.backups, dumps[0] ?? ''), 'utf8'), 'PGDMP');
    // The dump holds the whole database, so only the deploy account reads it.
    assert.equal(statSync(path.join(fixture.backups, dumps[0] ?? '')).mode & 0o777, 0o600);
  });

  it('exits before any Docker call when a release changes no image and no configuration', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const first = releaseFile(fixture);

    const result = await deploy(fixture, { RELEASE_SHA: NEXT_SHA });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changes no image and no configuration: nothing to do/);
    assert.deepEqual(logLines(fixture.log), []);
    // The commit is recorded; the running api keeps reporting its own version.
    assert.deepEqual(releaseFile(fixture), { ...first, RELEASE_SHA: NEXT_SHA });
    assert.equal(existsSync(path.join(fixture.root, '.release.prev.env')), false);
  });

  it('pulls and recreates only what changed, keeping APP_VERSION while the api image stays', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const first = releaseFile(fixture);
    const webImage = imageRef('web', '2');

    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      WEB_IMAGE: webImage,
      DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a1,web w2,caddy c1,worker-rcon k1',
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = dockerCommands(fixture.log);
    assert.deepEqual(
      commands.filter((line) => line.startsWith('docker|pull|')),
      [`docker|pull|--quiet|${webImage}`],
    );
    assert.equal(
      commands.some((line) => /pg_dump|migrator|\|up\|-d\|postgres/.test(line)),
      false,
    );
    assert.equal(commands.filter((line) => line.endsWith('|up|-d|--remove-orphans')).length, 1);
    assert.match(result.stdout, /Recreated: web;/);

    const recorded = releaseFile(fixture);
    assert.equal(recorded.RELEASE_SHA, NEXT_SHA);
    assert.equal(recorded.APP_VERSION, RELEASE_SHA);
    assert.equal(recorded.WEB_IMAGE, webImage);
    assert.deepEqual(releaseFile(fixture, '.release.prev.env'), first);
  });

  it('reports the new commit once the api image changes', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      API_IMAGE: imageRef('api', '2'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(releaseFile(fixture).APP_VERSION, NEXT_SHA);
    assert.match(result.stdout, new RegExp(`APP_VERSION=${NEXT_SHA}`));
  });

  it('backs up and migrates before the new containers start, only when drizzle changed', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    mkdirSync(fixture.backups, { recursive: true });
    for (let day = 1; day <= 6; day += 1) {
      writeFileSync(path.join(fixture.backups, `panel-2020010${day}T000000Z-old.dump`), 'PGDMP');
    }
    writeFileSync(path.join(fixture.root, 'packages/db/drizzle/0001_next.sql'), 'ALTER TABLE t;\n');

    const result = await deploy(fixture, { RELEASE_SHA: NEXT_SHA });
    assert.equal(result.status, 0, result.stderr);
    const commands = dockerCommands(fixture.log);
    const dump = commands.findIndex((line) => line.includes('|pg_dump|'));
    const migrate = commands.indexOf(`${COMPOSE}|run|--rm|-T|migrator`);
    const up = commands.indexOf(`${COMPOSE}|up|-d|--remove-orphans`);
    assert.ok(dump >= 0 && migrate > dump && up > migrate, commands.join('\n'));
    assert.equal(
      commands.some((line) => line.startsWith('docker|pull|')),
      false,
    );
    // The newest five dumps survive: this deploy's, the first deploy's, and
    // the three most recent of the older ones.
    const dumps = readdirSync(fixture.backups).sort();
    assert.equal(dumps.length, 5, dumps.join('\n'));
    assert.deepEqual(dumps.slice(0, 3), [
      'panel-20200104T000000Z-old.dump',
      'panel-20200105T000000Z-old.dump',
      'panel-20200106T000000Z-old.dump',
    ]);
    assert.ok(dumps.some((name) => name.endsWith(`-${NEXT_SHA.slice(0, 12)}.dump`)));
    assert.notEqual(
      releaseFile(fixture).MIGRATIONS_SHA,
      releaseFile(fixture, '.release.prev.env').MIGRATIONS_SHA,
    );
  });

  it('stops before any app container is replaced when a migration fails', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const running = readFileSync(path.join(fixture.root, '.release.env'), 'utf8');
    writeFileSync(path.join(fixture.root, 'packages/db/drizzle/0001_next.sql'), 'ALTER TABLE t;\n');

    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      API_IMAGE: imageRef('api', '2'),
      FAIL_DOCKER_MATCH: 'run --rm -T migrator',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /migrations failed; no app container was recreated \(backup: /);
    const commands = dockerCommands(fixture.log);
    assert.ok(commands.some((line) => line.includes('|pg_dump|')));
    assert.equal(
      commands.some((line) => line.includes('--remove-orphans')),
      false,
    );
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('curl|')),
      false,
    );
    assert.equal(readFileSync(path.join(fixture.root, '.release.env'), 'utf8'), running);
    assert.equal(existsSync(path.join(fixture.root, '.release.prev.env')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
  });

  it('does not migrate when the pre-migration backup fails', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { FAIL_DOCKER_MATCH: 'pg_dump' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /database backup failed; nothing was migrated or recreated/);
    const commands = dockerCommands(fixture.log);
    assert.equal(
      commands.some((line) => line.includes('migrator') || line.includes('--remove-orphans')),
      false,
    );
    assert.deepEqual(readdirSync(fixture.backups), []);
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('applies a Caddyfile or .env.stand edit even when no image changed', async () => {
    for (const edited of ['docker/Caddyfile.stand', '.env.stand']) {
      const fixture = deployFixture();
      assert.equal((await deploy(fixture)).status, 0);
      const first = releaseFile(fixture);
      writeFileSync(path.join(fixture.root, edited), '# edited\n', { flag: 'a' });

      const result = await deploy(fixture, { RELEASE_SHA: NEXT_SHA });
      assert.equal(result.status, 0, result.stderr);
      const commands = dockerCommands(fixture.log);
      assert.ok(commands.includes(`${COMPOSE}|up|-d|--remove-orphans`), edited);
      assert.equal(
        commands.some((line) => line.startsWith('docker|pull|') || line.includes('migrator')),
        false,
      );
      const recorded = releaseFile(fixture);
      const hash = edited === '.env.stand' ? 'COMPOSE_CONFIG_SHA' : 'CADDYFILE_SHA';
      assert.notEqual(recorded[hash], first[hash], edited);
    }
  });

  it('fails closed when a recreated service never becomes ready, keeping the recorded release', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const running = readFileSync(path.join(fixture.root, '.release.env'), 'utf8');

    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      WEB_IMAGE: imageRef('web', '2'),
      DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a1,web w2,caddy c1,worker-rcon k1',
      DOCKER_HEALTH: 'api running healthy,web running starting',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not ready after 3s: web\(running\/starting\)/);
    assert.equal(logLines(fixture.log).filter((line) => line.startsWith('sleep|')).length, 3);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('curl|')),
      false,
    );
    assert.doesNotMatch(result.stdout, /is live/);
    assert.equal(readFileSync(path.join(fixture.root, '.release.env'), 'utf8'), running);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
  });

  // regression (#290): the Caddy probe used to be a single-shot `curl -f`. The
  // api-health wait returns as soon as the api container is healthy, but caddy
  // starts in the same `up -d` and needs a moment more to bind 443, so the
  // probe raced the deploy it verifies. Run 31948383567 went red with curl
  // exit 35 (SSL connect error) 140 ms after caddy started, while the stack
  // was healthy and serving https://<APP_DOMAIN>/health with a 200.
  it('retries the Caddy probe while TLS is still coming up, then reports success', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { CURL_FAIL_TIMES: '3', CURL_EXIT: '35' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /is live/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('curl|'));
    assert.equal(probes.length, 4, 'expected 3 failed probes then one success');
    assert.ok(probes.every((line) => line.includes('|--resolve|stand.example:443:127.0.0.1|')));
  });

  it('still fails closed, preserving the curl exit code, when the probe never recovers', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { CURL_EXIT: '35' });
    assert.equal(result.status, 35);
    assert.match(
      result.stderr,
      /health probe through Caddy failed after 20 attempts \(curl exit 35/,
    );
    assert.doesNotMatch(result.stdout, /is live/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('curl|'));
    assert.equal(probes.length, 20, 'expected the retry budget to be exhausted');
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('fails when /health keeps reporting a version other than the recorded one', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { CURL_VERSION: 'stale' });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`expected version ${RELEASE_SHA}, last response: .*"stale"`),
    );
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('propagates a failed start without probing or recording the release', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, {
      FAIL_DOCKER_MATCH: 'up -d --remove-orphans',
      FAIL_CODE: '47',
    });
    assert.equal(result.status, 47);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('curl|')),
      false,
    );
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
  });

  it('removes panel images other than the running and the previous release', async () => {
    const fixture = deployFixture();
    const first = releaseImages('1');
    const second = releaseImages('1', { WEB_IMAGE: imageRef('web', '2') });
    const present = [...Object.values(first), second.WEB_IMAGE].join(',');
    const staleWeb = imageRef('web', '3');
    const staleApi = imageRef('api', '0');
    const repoIds = [...Object.values(first), second.WEB_IMAGE, staleWeb, staleApi]
      .map((reference) => `id:${reference}`)
      .join(',');
    assert.equal((await deploy(fixture, { DOCKER_PRESENT: present })).status, 0);

    const result = await deploy(fixture, {
      ...second,
      RELEASE_SHA: NEXT_SHA,
      DOCKER_PRESENT: present,
      DOCKER_REPO_IDS: repoIds,
    });
    assert.equal(result.status, 0, result.stderr);
    const removed = dockerCommands(fixture.log)
      .filter((line) => line.startsWith('docker|image|rm|'))
      .map((line) => line.split('|').at(-1));
    assert.deepEqual(removed.sort(), [`id:${staleApi}`, `id:${staleWeb}`].sort());
    // Already on the host, so nothing was pulled.
    assert.equal(
      dockerCommands(fixture.log).some((line) => line.startsWith('docker|pull|')),
      false,
    );
  });
});

describe('the stand host rollback', { concurrency: true }, () => {
  /** A deploy fixture with the real rollback script next to the real deploy script. */
  function rollbackFixture(): DeployFixture & { rollback: string } {
    const fixture = deployFixture();
    const rollback = path.join(fixture.root, 'scripts/rollback-stand.sh');
    copyFileSync(path.join(REPOSITORY_ROOT, 'scripts/rollback-stand.sh'), rollback);
    return { ...fixture, rollback };
  }

  it('redeploys the previous release and swaps the release files, without migrating', async () => {
    const fixture = rollbackFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const first = releaseFile(fixture);
    const second = releaseImages('2');
    assert.equal((await deploy(fixture, { ...second, RELEASE_SHA: NEXT_SHA })).status, 0);
    const current = releaseFile(fixture);
    assert.equal(current.APP_VERSION, NEXT_SHA);

    // Only the current images are still on the host: the previous ones are pulled.
    const result = await deploy(
      fixture,
      { DOCKER_PRESENT: Object.values(second).join(','), RELEASE_SHA: 'ignored' },
      fixture.rollback,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Rolling back ${NEXT_SHA} -> ${RELEASE_SHA}`));
    assert.deepEqual(releaseFile(fixture), first);
    assert.deepEqual(releaseFile(fixture, '.release.prev.env'), current);
    const commands = dockerCommands(fixture.log);
    assert.deepEqual(
      commands.filter((line) => line.startsWith('docker|pull|')),
      IMAGES.map(([key]) => `docker|pull|--quiet|${releaseImages('1')[key]}`),
    );
    assert.equal(
      commands.some((line) => line.includes('pg_dump') || line.includes('migrator')),
      false,
    );

    // A second rollback returns to where it started.
    assert.equal((await deploy(fixture, {}, fixture.rollback)).status, 0);
    assert.deepEqual(releaseFile(fixture), current);
  });

  it('refuses without a complete previous release, or onto the running one', async () => {
    const empty = rollbackFixture();
    const none = await deploy(empty, {}, empty.rollback);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no previous release recorded/);
    assert.deepEqual(logLines(empty.log), []);

    const partial = rollbackFixture();
    writeFileSync(path.join(partial.root, '.release.prev.env'), `RELEASE_SHA=${RELEASE_SHA}\n`);
    const incomplete = await deploy(partial, {}, partial.rollback);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /records no API_IMAGE/);
    assert.deepEqual(logLines(partial.log), []);

    const same = rollbackFixture();
    assert.equal((await deploy(same)).status, 0);
    copyFileSync(path.join(same.root, '.release.env'), path.join(same.root, '.release.prev.env'));
    const onto = await deploy(same, {}, same.rollback);
    assert.equal(onto.status, 1);
    assert.match(onto.stderr, /already the running release/);
    assert.deepEqual(logLines(same.log), []);
  });

  it('warns instead of silently redeploying a release it just rolled back away from (#76)', async () => {
    const fixture = rollbackFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const second = releaseImages('2');
    assert.equal((await deploy(fixture, { ...second, RELEASE_SHA: NEXT_SHA })).status, 0);

    // Roll back NEXT_SHA -> RELEASE_SHA. deploy-stand.sh's unconditional
    // release-file swap now leaves .release.prev.env holding NEXT_SHA (the
    // release just left), so a follow-up rollback would read it straight
    // back out with no signal that it was ever rolled away from.
    const first = await deploy(
      fixture,
      { DOCKER_PRESENT: Object.values(second).join(',') },
      fixture.rollback,
    );
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(releaseFile(fixture, '.release.bad.env'), { RELEASE_SHA: NEXT_SHA });

    // A second rollback (the documented, tested round trip) targets
    // .release.prev.env, which now holds NEXT_SHA — exactly the release
    // .release.bad.env just recorded. It must still succeed (this round
    // trip is intended), but it must no longer be silent about redeploying
    // a release this script itself rolled away from.
    const second_rollback = await deploy(fixture, {}, fixture.rollback);
    assert.equal(second_rollback.status, 0, second_rollback.stderr);
    assert.match(second_rollback.stderr, /rolled back away from previously/);
    assert.deepEqual(releaseFile(fixture).APP_VERSION, NEXT_SHA);
  });
});

describe('the stand host forced-command deploy entry', { concurrency: true }, () => {
  const VALID = [
    'deploy',
    RELEASE_SHA,
    `api=sha256:${'1'.repeat(64)}`,
    `web=sha256:${'2'.repeat(64)}`,
    `workers=sha256:${'3'.repeat(64)}`,
    `caddy=sha256:${'4'.repeat(64)}`,
  ].join(' ');

  function entryFixture(): {
    root: string;
    script: string;
    log: string;
    src: string;
    app: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/deploy-entry.sh');
    const src = path.join(root, 'src');
    const app = path.join(root, 'app');
    // rsync is a shim, so the synced tree is prepared by hand; its deploy
    // script is a stand-in recording what the entry handed over.
    mkdirSync(path.join(app, 'scripts'), { recursive: true });
    executable(
      path.join(app, 'scripts/deploy-stand.sh'),
      `printf 'deploy|%s|%s|%s|%s|%s|%s|%s\\n' "$PWD" "$APP_DIR" "$RELEASE_SHA" "$API_IMAGE" "$WEB_IMAGE" "$WORKERS_IMAGE" "$CADDY_IMAGE" >> "\${OPS_LOG:?}"`,
    );
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(
      shims,
      'git',
      [
        `if [[ -n "\${FAIL_GIT_MATCH:-}" && "$*" == *"$FAIL_GIT_MATCH"* ]]; then exit 128; fi`,
        `if [[ "$*" == *'rev-parse HEAD' ]]; then printf '%s\\n' "\${GIT_HEAD:-}"; fi`,
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'rsync');
    return {
      root,
      script,
      log,
      src,
      app,
      env: {
        OPS_LOG: log,
        PANEL_SRC_DIR: src,
        PANEL_APP_DIR: app,
        PATH: `${shims}:/usr/bin:/bin`,
        GIT_HEAD: RELEASE_SHA,
        // The runner's own session must not leak a request into the test.
        SSH_ORIGINAL_COMMAND: undefined,
      },
    };
  }

  it('refuses anything but the exact deploy request, before git, rsync or the deploy', async () => {
    const fixture = entryFixture();
    const sentinel = path.join(fixture.root, 'pwned');
    const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
    const requests = [
      '',
      'deploy',
      `${VALID}; rm -rf ~`,
      `${VALID} && touch ${sentinel}`,
      `${VALID} extra`,
      `${VALID}\ntouch ${sentinel}`,
      `${VALID}\n`,
      ` ${VALID}`,
      VALID.replace(' api=', '  api='),
      VALID.replace(' api=', '\tapi='),
      VALID.replace(RELEASE_SHA, RELEASE_SHA.slice(1)),
      VALID.replace(RELEASE_SHA, `${RELEASE_SHA}0`),
      VALID.replace(RELEASE_SHA, RELEASE_SHA.toUpperCase()),
      VALID.replace(RELEASE_SHA, `$(touch ${sentinel})`),
      VALID.replace(digest('2'), digest('2').toUpperCase()),
      VALID.replace(digest('2'), '2'.repeat(64)),
      VALID.replace(digest('3'), `sha256:${'3'.repeat(63)}`),
      VALID.replace(`web=${digest('2')} workers=`, `workers=${digest('2')} web=`),
      VALID.replace('caddy=', 'caddy-stand='),
      VALID.replace('deploy ', 'rollback '),
    ];
    for (const request of requests) {
      const result = await runAsync('/bin/bash', [fixture.script], {
        env: { ...fixture.env, SSH_ORIGINAL_COMMAND: request },
      });
      assert.equal(result.status, 2, JSON.stringify(request));
      assert.match(result.stderr, /^refused: expected 'deploy <40-hex sha> api=sha256:/);
      assert.deepEqual(logLines(fixture.log), [], JSON.stringify(request));
    }
    const bare = await runAsync('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(bare.status, 2);
    // A forced command's request always wins over arguments.
    const smuggled = await runAsync('/bin/bash', [fixture.script, ...VALID.split(' ')], {
      env: { ...fixture.env, SSH_ORIGINAL_COMMAND: 'rollback' },
    });
    assert.equal(smuggled.status, 2);
    assert.deepEqual(logLines(fixture.log), []);
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(fixture.src), false);
  });

  it('fetches the commit, syncs it without host state, and hands over to its deploy script', async () => {
    const fixture = entryFixture();
    const result = await runAsync('/bin/bash', [fixture.script], {
      env: { ...fixture.env, SSH_ORIGINAL_COMMAND: VALID },
    });
    assert.equal(result.status, 0, result.stderr);
    const excludes = [
      '.git',
      'node_modules',
      '.next',
      'data',
      'dist',
      '.env',
      '.env.*',
      '.release*',
    ]
      .map((pattern) => `--exclude|${pattern}`)
      .join('|');
    assert.deepEqual(logLines(fixture.log), [
      `git|init|--quiet|${fixture.src}`,
      `git|-C|${fixture.src}|fetch|--quiet|--depth=1|--no-tags|https://github.com/seregatipich/squad-admin-panel.git|${RELEASE_SHA}`,
      `git|-C|${fixture.src}|-c|advice.detachedHead=false|checkout|--quiet|--force|--detach|${RELEASE_SHA}`,
      `git|-C|${fixture.src}|clean|--quiet|-ffdx`,
      `git|-C|${fixture.src}|rev-parse|HEAD`,
      `rsync|-a|--delete|${excludes}|${fixture.src}/|${fixture.app}/`,
      [
        'deploy',
        fixture.app,
        fixture.app,
        RELEASE_SHA,
        imageRef('api', '1'),
        imageRef('web', '2'),
        imageRef('workers', '3'),
        imageRef('caddy', '4'),
      ].join('|'),
    ]);
    // No installed copy exists in the fixture's checkout, so it says to reinstall.
    assert.match(result.stderr, /differs from scripts\/deploy-entry\.sh .* reinstall it/);
  });

  it('takes the same request as arguments when run by hand, with overridable locations', async () => {
    const fixture = entryFixture();
    mkdirSync(path.join(fixture.src, '.git'), { recursive: true });
    mkdirSync(path.join(fixture.src, 'scripts'), { recursive: true });
    copyFileSync(fixture.script, path.join(fixture.src, 'scripts/deploy-entry.sh'));
    const result = await runAsync('/bin/bash', [fixture.script, ...VALID.split(' ')], {
      env: {
        ...fixture.env,
        PANEL_REPO_URL: 'https://example.invalid/fork.git',
        PANEL_IMAGE_REPO: 'ghcr.io/example/panel',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = logLines(fixture.log);
    // The checkout already exists, so it is reused rather than initialised.
    assert.equal(
      commands.some((line) => line.startsWith('git|init|')),
      false,
    );
    assert.ok(commands.some((line) => line.includes('|https://example.invalid/fork.git|')));
    assert.ok(commands.at(-1)?.includes(`|ghcr.io/example/panel-api@sha256:${'1'.repeat(64)}|`));
    assert.doesNotMatch(result.stderr, /reinstall/);
  });

  it('stops before syncing when the commit cannot be fetched or checked out', async () => {
    const unfetchable = entryFixture();
    const fetchFailure = await runAsync('/bin/bash', [unfetchable.script], {
      env: { ...unfetchable.env, SSH_ORIGINAL_COMMAND: VALID, FAIL_GIT_MATCH: 'fetch' },
    });
    assert.equal(fetchFailure.status, 128);
    assert.equal(
      logLines(unfetchable.log).some(
        (line) => line.startsWith('rsync|') || line.startsWith('deploy|'),
      ),
      false,
    );

    const elsewhere = entryFixture();
    const wrongHead = await runAsync('/bin/bash', [elsewhere.script], {
      env: { ...elsewhere.env, SSH_ORIGINAL_COMMAND: VALID, GIT_HEAD: 'b'.repeat(40) },
    });
    assert.equal(wrongHead.status, 1);
    assert.match(wrongHead.stderr, /is at 'b{40}', expected a{40}/);
    assert.equal(
      logLines(elsewhere.log).some(
        (line) => line.startsWith('rsync|') || line.startsWith('deploy|'),
      ),
      false,
    );
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
      'media',
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
        // rebuild.sh resolves each compose service's container id by name
        // (docker compose ps -q <service>) rather than guessing a
        // project-prefixed container name.
        'if [[ "$1" == \'compose\' && "$2" == \'ps\' ]]; then printf \'fake-%s-id\\n\' "$4"; exit 0; fi',
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
      'media',
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
      logLines(fixture.log)
        .filter((line) => line.startsWith('docker|compose|'))
        .slice(0, 4),
      [
        'docker|compose|down|--remove-orphans',
        'docker|compose|down|-v',
        'docker|compose|build|--no-cache|--progress=plain',
        'docker|compose|up|-d',
      ],
    );
    // Health polling resolves each service's container id by name (docker
    // compose ps -q <service>) instead of guessing a project-prefixed
    // container name.
    assert.ok(logLines(fixture.log).some((line) => line === 'docker|compose|ps|-q|api'));
    assert.ok(logLines(fixture.log).some((line) => line === 'docker|compose|ps|-q|migrator'));
  });

  it('re-binds squad-depot to data/depot and recreates every bind-mounted data directory', () => {
    const fixture = rebuildFixture();
    // An install that predates the media volume has no data/media yet; the
    // compose bind mount fails to start the api without it (#48).
    rmSync(path.join(fixture.root, 'data/media'), { recursive: true, force: true });
    const result = run('/bin/bash', [fixture.script], {
      env: fixture.env,
      input: 'rebuild\n',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const subdirectory of ['media', 'depot', 'backup-dump']) {
      assert.equal(existsSync(path.join(fixture.root, 'data', subdirectory)), true, subdirectory);
    }
    const commands = logLines(fixture.log);
    const removed = commands.indexOf('docker|volume|rm|squad-depot');
    const created = commands.indexOf(
      `docker|volume|create|--driver|local|--opt|type=none|--opt|o=bind|--opt|device=${path.join(fixture.root, 'data/depot')}|squad-depot`,
    );
    const started = commands.indexOf('docker|compose|up|-d');
    assert.ok(removed >= 0 && removed < created && created < started, commands.join('\n'));
  });

  it('stops before building when squad-depot cannot be re-bound', () => {
    const fixture = rebuildFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, FAIL_DOCKER_MATCH: 'volume create', FAIL_CODE: '47' },
      input: 'rebuild\n',
    });
    assert.equal(result.status, 47);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('docker|compose|build')),
      false,
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

/**
 * `scripts/restore.sh --apply` against stand-in tools (#48). The `docker` shim
 * answers the compose queries, emulates the backup container's staging run by
 * writing the dumps into the fixture's backup-dump volume, and runs the Redis
 * conversion script for real under `sh` with fake `redis-server`/`redis-cli`,
 * so the bounded waits are exercised as shipped. Multi-line `-c` scripts are
 * logged as `SCRIPT:<kind>` and saved whole under `scripts/<n>.sh`.
 */
describe('restore apply: staging, worker pause, transactional pg_restore, Redis rollback', () => {
  function restoreFixture(): {
    root: string;
    script: string;
    log: string;
    dataDir: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/restore.sh');
    const dataDir = path.join(root, 'data');
    mkdirSync(path.join(dataDir, 'redis/appendonlydir'), { recursive: true });
    writeFileSync(path.join(dataDir, 'redis/appendonlydir/live.aof'), 'live aof');
    writeFileSync(path.join(dataDir, 'redis/dump.rdb'), 'live rdb');
    mkdirSync(path.join(dataDir, 'backup-dump'), { recursive: true });
    writeFileSync(path.join(root, '.env'), `DATA_DIR=${dataDir}\nPOSTGRES_PASSWORD=x\n`);
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    const savedScripts = path.join(root, 'scripts-run');
    mkdirSync(savedScripts);
    executable(
      path.join(shims, 'docker'),
      [
        'body=""',
        'line=docker',
        'previous=""',
        'for argument in "$@"; do',
        '  if [[ "$previous" == "-c" ]]; then',
        '    body=$argument',
        '    case "$argument" in',
        "      *'restic restore'*) kind=stage ;;",
        '      *pg_restore*) kind=pg_restore ;;',
        '      *redis-server*) kind=redis ;;',
        '      */data/pre-restore\\ ]*) kind=redis_guard ;;',
        '      *) kind=other ;;',
        '    esac',
        '    argument="SCRIPT:$kind"',
        '  fi',
        '  line="$line|$argument"',
        '  previous=$argument',
        'done',
        `printf "%s\\n" "$line" >> "\${OPS_LOG:?}"`,
        'if [[ -n "$body" ]]; then',
        '  printf "%s" "$body" > "$OPS_SCRIPTS/$(grep -c . "$OPS_LOG").sh"',
        'fi',
        'case "$line" in',
        "  *'|ps|--format|'*) printf 'postgres healthy\\nredis healthy\\n' ;;",
        "  *'|ps|--services|--status|running'*) printf 'caddy\\napi\\nworker-rcon\\npostgres\\nredis\\nworker-log-ingest\\n' ;;",
        '  *SCRIPT:stage*)',
        `    [[ "\${STAGE_EXIT:-0}" == 0 ]] || exit "$STAGE_EXIT"`,
        '    mkdir -p "$OPS_DATA/backup-dump/restore"',
        '    printf "restored pg" > "$OPS_DATA/backup-dump/restore/admin.dump"',
        `    [[ -n "\${STAGE_NO_RDB:-}" ]] || printf "restored rdb" > "$OPS_DATA/backup-dump/restore/dump.rdb"`,
        '    ;;',
        `  *SCRIPT:pg_restore*) exit "\${PG_RESTORE_EXIT:-0}" ;;`,
        '  *SCRIPT:redis_guard*) [[ ! -e "$OPS_DATA/redis/pre-restore" ]] || exit 1 ;;',
        // Stands in for the one-off container: its /data is the redis volume
        // and /restore the staged dumps. The fixture path contains spaces, so
        // the script sees both through space-free symlinks.
        '  *SCRIPT:redis*)',
        '    view=$(mktemp -d /tmp/ops-redis-view.XXXXXX)',
        '    ln -s "$OPS_DATA/redis" "$view/data"',
        '    ln -s "$OPS_DATA/backup-dump/restore" "$view/restore"',
        '    status=0',
        '    sh -c "$(printf "%s" "$body" | sed -e "s#/restore#$view/restore#g" -e "s#/data#$view/data#g")" || status=$?',
        '    rm -rf "$view"',
        '    exit "$status"',
        '    ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    const serverPid = path.join(root, 'redis-server.pid');
    executable(
      path.join(shims, 'redis-server'),
      [
        `printf '%s' "$$" > '${serverPid}'`,
        `if [[ -n "\${REDIS_SERVER_CRASH:-}" ]]; then exit 1; fi`,
        'exec /bin/sleep 30',
      ].join('\n'),
    );
    executable(
      path.join(shims, 'redis-cli'),
      [
        'case "$1" in',
        `  ping) [[ -n "\${REDIS_NO_PONG:-}\${REDIS_SERVER_CRASH:-}" ]] || printf "PONG\\n" ;;`,
        "  info) printf 'aof_rewrite_in_progress:0\\r\\naof_last_bgrewrite_status:ok\\r\\n' ;;",
        `  shutdown) kill "$(cat '${serverPid}')" 2>/dev/null ;;`,
        'esac',
        'exit 0',
      ].join('\n'),
    );
    executable(path.join(shims, 'sleep'), 'exit 0');
    return {
      root,
      script,
      log,
      dataDir,
      env: {
        OPS_LOG: log,
        OPS_DATA: dataDir,
        OPS_SCRIPTS: savedScripts,
        PATH: `${shims}:/usr/bin:/bin`,
      },
    };
  }

  const apply = (fixture: ReturnType<typeof restoreFixture>, env: NodeJS.ProcessEnv = {}) =>
    run('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: { ...fixture.env, ...env },
    });

  const indexOf = (commands: string[], pattern: RegExp): number =>
    commands.findIndex((line) => pattern.test(line));

  it('stages both dumps first, pauses only the workers, restores Postgres in one transaction', () => {
    const fixture = restoreFixture();
    const result = apply(fixture);
    assert.equal(result.status, 0, result.stderr);
    const commands = logLines(fixture.log);

    const stage = indexOf(commands, /SCRIPT:stage/);
    const stopWorkers = commands.indexOf(
      'docker|compose|--profile|backup|stop|worker-rcon|worker-log-ingest',
    );
    const pgRestore = indexOf(commands, /SCRIPT:pg_restore/);
    const stopRedis = commands.indexOf('docker|compose|--profile|backup|stop|redis');
    const startWorkers = commands.indexOf(
      'docker|compose|--profile|backup|start|worker-rcon|worker-log-ingest',
    );
    assert.ok(stage >= 0 && stage < stopWorkers, commands.join('\n'));
    assert.ok(stopWorkers < pgRestore && pgRestore < stopRedis, commands.join('\n'));
    assert.equal(startWorkers, commands.length - 1, commands.join('\n'));
    // The api holds the bridge connection that keeps this script alive.
    assert.equal(
      commands.some((line) => /\|stop\|.*\b(api|web|caddy|postgres)\b/.test(line)),
      false,
    );

    const pgScript = readFileSync(
      path.join(fixture.root, 'scripts-run', `${pgRestore + 1}.sh`),
      'utf8',
    );
    assert.match(pgScript, /pg_restore --single-transaction --exit-on-error --clean --if-exists/);

    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'),
      'restored rdb',
    );
    assert.equal(existsSync(path.join(fixture.dataDir, 'redis/appendonlydir')), false);
    assert.equal(existsSync(path.join(fixture.dataDir, 'redis/pre-restore')), false);
    assert.equal(existsSync(path.join(fixture.dataDir, 'backup-dump/restore')), false);
    assert.ok(commands.includes('docker|compose|--profile|backup|up|-d|redis'));
  });

  it('checks the staged dump.rdb before touching Postgres, the workers or Redis', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { STAGE_NO_RDB: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staged dump\.rdb missing/);
    const commands = logLines(fixture.log);
    assert.equal(indexOf(commands, /SCRIPT:pg_restore/), -1, commands.join('\n'));
    assert.equal(indexOf(commands, /\|stop\|/), -1, commands.join('\n'));
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'redis/appendonlydir/live.aof'), 'utf8'),
      'live aof',
    );
  });

  it('starts the workers again and leaves Redis alone when pg_restore fails', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { PG_RESTORE_EXIT: '3' });
    assert.equal(result.status, 3);
    const commands = logLines(fixture.log);
    assert.equal(commands.includes('docker|compose|--profile|backup|stop|redis'), false);
    assert.equal(
      commands.at(-1),
      'docker|compose|--profile|backup|start|worker-rcon|worker-log-ingest',
    );
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
    assert.equal(existsSync(path.join(fixture.dataDir, 'backup-dump/restore')), false);
  });

  it('puts the previous Redis dataset back and restarts redis when the RDB will not load', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { REDIS_SERVER_CRASH: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /redis-server exited while loading dump\.rdb/);
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'redis/appendonlydir/live.aof'), 'utf8'),
      'live aof',
    );
    assert.equal(existsSync(path.join(fixture.dataDir, 'redis/pre-restore')), false);
    const commands = logLines(fixture.log);
    const upRedis = commands.lastIndexOf('docker|compose|--profile|backup|up|-d|redis');
    assert.ok(upRedis > indexOf(commands, /SCRIPT:redis/), commands.join('\n'));
    assert.equal(
      commands.at(-1),
      'docker|compose|--profile|backup|start|worker-rcon|worker-log-ingest',
    );
  });

  it('gives up on a redis-server that never answers instead of waiting forever', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { REDIS_NO_PONG: '1', REDIS_READY_ATTEMPTS: '5' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not answer PING after 5 attempts/);
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
  });

  it('passes an ENV_FILE override to compose unless the bridge set COMPOSE_ENV_FILES', () => {
    const fixture = restoreFixture();
    writeFileSync(path.join(fixture.root, '.env.stand'), `DATA_DIR=${fixture.dataDir}\n`);
    const composeCalls = (env: NodeJS.ProcessEnv): string[] => {
      const result = run('/bin/bash', [fixture.script], {
        cwd: fixture.root,
        env: { ...fixture.env, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return logLines(fixture.log).filter((line) => line.startsWith('docker|compose'));
    };

    const override = composeCalls({ ENV_FILE: '.env.stand', COMPOSE_ENV_FILES: '' });
    assert.ok(
      override.length > 0 && override.every((line) => line.includes('|--env-file|.env.stand|')),
    );
    writeFileSync(fixture.log, '');
    // --env-file would replace COMPOSE_ENV_FILES and drop the stand's .release.env.
    const bridge = composeCalls({
      ENV_FILE: '.env.stand',
      COMPOSE_ENV_FILES: '.env.stand,.release.env',
    });
    assert.ok(bridge.length > 0 && bridge.every((line) => !line.includes('--env-file')));
  });

  it('refuses to run over the moved-aside dataset of an interrupted restore', () => {
    const fixture = restoreFixture();
    mkdirSync(path.join(fixture.dataDir, 'redis/pre-restore'));
    const result = apply(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interrupted restore/);
    const commands = logLines(fixture.log);
    assert.equal(indexOf(commands, /SCRIPT:stage/), -1, commands.join('\n'));
    assert.equal(indexOf(commands, /\|stop\|/), -1, commands.join('\n'));
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
    mkdirSync(path.join(root, 'data/postgres'), { recursive: true });
    mkdirSync(path.join(root, 'data/backup-repo'), { recursive: true });
    mkdirSync(path.join(root, 'data/backup-dump'), { recursive: true });
    writeFileSync(path.join(root, 'data/sentinel'), 'safe temporary data');
    writeFileSync(path.join(root, 'data/.hidden'), 'dot file');
    writeFileSync(path.join(root, 'data/postgres/PG_VERSION'), '16');
    writeFileSync(path.join(root, 'data/backup-repo/config'), 'restic repository');
    writeFileSync(path.join(root, 'data/backup-dump/admin.dump'), 'logical dump');
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
    loggingShim(
      shims,
      'docker',
      `if [[ -n "\${FAIL_DOCKER_MATCH:-}" && "$*" == *"$FAIL_DOCKER_MATCH"* ]]; then exit 51; fi; exit 0`,
    );
    loggingShim(shims, 'groupdel');
    return {
      root,
      script,
      log,
      env: { OPS_LOG: log, OPS_SAFE_ROOT: root, PATH: `${shims}:/usr/bin:/bin` },
    };
  }

  const composeDown = 'docker|compose|--profile|backup|down|-v|--remove-orphans';

  it('executes confirmed cleanup in order while remapping host mutations', () => {
    const fixture = uninstallFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: fixture.env,
      input: 'y\ny\ny\ny\ny\ny\ny\n',
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
        commands.indexOf(composeDown),
    );
    assert.ok(
      commands.indexOf(composeDown) < commands.indexOf(`rm|-rf|${path.join(fixture.root, 'data')}`),
    );
    assert.equal(commands.at(-1), 'groupdel|panel');
  });

  it('names the backups in the data prompt and keeps them unless separately confirmed', () => {
    const fixture = uninstallFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: fixture.env,
      input: 'y\ny\ny\ny\ny\nn\ny\n',
    });
    assert.equal(result.status, 0, result.stderr);
    // `read -p` only shows its prompt on a terminal, so the warning is logged.
    assert.match(result.stdout, /restic backup repository \(backup-repo\/\)/);
    assert.match(
      readFileSync(fixture.script, 'utf8'),
      /confirm "Remove data tree .*backups in backup-repo\/ and backup-dump\/ are kept/,
    );
    const data = path.join(fixture.root, 'data');
    assert.deepEqual(readdirSync(data).sort(), ['backup-dump', 'backup-repo']);
    assert.equal(readFileSync(path.join(data, 'backup-repo/config'), 'utf8'), 'restic repository');
    assert.equal(readFileSync(path.join(data, 'backup-dump/admin.dump'), 'utf8'), 'logical dump');
    assert.ok(logLines(fixture.log).includes(composeDown));
  });

  it('stops the compose stack before deleting any data and aborts when that fails', () => {
    const fixture = uninstallFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, FAIL_DOCKER_MATCH: 'down' },
      input: 'y\ny\ny\ny\ny\ny\ny\n',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not stop the compose stack/);
    const commands = logLines(fixture.log);
    assert.equal(
      commands.some((line) => line.startsWith(`rm|-rf|${path.join(fixture.root, 'data')}`)),
      false,
    );
    assert.equal(existsSync(path.join(fixture.root, 'data/postgres/PG_VERSION')), true);
    assert.equal(commands.includes('groupdel|panel'), false);
  });

  it('leaves the stack and data alone when the data step is declined', () => {
    const fixture = uninstallFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: fixture.env,
      input: 'n\nn\nn\nn\nn\nn\nn\n',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('docker|')),
      false,
    );
    assert.equal(existsSync(path.join(fixture.root, 'data/postgres/PG_VERSION')), true);
  });

  it('stops at daemon-reload failure and leaves later resources untouched', () => {
    const fixture = uninstallFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, FAIL_SYSTEMCTL_MATCH: 'daemon-reload', FAIL_CODE: '48' },
      input: 'y\ny\ny\ny\ny\ny\ny\n',
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
  type BridgeReply = Record<string, unknown> | 'close';
  type BridgeResponder = (request: Record<string, unknown>) => BridgeReply;

  /** Replies like the real bridge: the allowlist probes are refused, the rest succeed. */
  const faithfulBridge: BridgeResponder = (request) => {
    const refusals: Record<string, string> = {
      file_read: 'forbidden: path "/etc/shadow" outside allowed roots',
      file_atomic_write:
        'forbidden: path "/opt/squad-servers/verify-bridge.tmp" outside allowed roots',
      container_run: 'forbidden: image "alpine:latest" not in allowlist',
    };
    const refusal = refusals[String(request.method)];
    if (refusal) {
      return { id: request.id, ok: false, error: { code: 'forbidden', message: refusal } };
    }
    return { id: request.id, ok: true, result: { method: request.method } };
  };

  async function bridgeServer(
    socketPath: string,
    respond: BridgeResponder = faithfulBridge,
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
        const reply = respond(request);
        if (reply === 'close') {
          socket.end();
          return;
        }
        const payload = Buffer.from(JSON.stringify(reply));
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

  async function runAgainst(
    prefix: string,
    respond?: BridgeResponder,
  ): Promise<{ result: CommandResult; requests: Array<Record<string, unknown>> }> {
    const socketPath = path.join(temporaryRoot(prefix), 'bridge.sock');
    const fixture = await bridgeServer(socketPath, respond);
    try {
      const result = await runAsync(
        '/bin/bash',
        [path.join(REPOSITORY_ROOT, 'scripts/verify-bridge.sh')],
        { env: { BRIDGE_SOCKET: socketPath } },
      );
      return { result, requests: fixture.requests };
    } finally {
      fixture.server.close();
      await once(fixture.server, 'close');
    }
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
    const { result, requests } = await runAgainst('verify-bridge');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[verify-bridge\].*done/);
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        'ping',
        'host_info',
        'host_metrics',
        'list_panel_dirs',
        'file_read',
        'file_atomic_write',
        'container_inspect',
        'container_run',
      ],
    );
    assert.equal(requests[3]?.params, null);
    assert.deepEqual(requests[4]?.params, { path: '/etc/shadow' });
    assert.deepEqual(requests[5]?.params, {
      path: '/opt/squad-servers/verify-bridge.tmp',
      content: 'verify-bridge ok\n',
      mode: 420,
    });
    // A valid server_id makes the image allowlist, not the UUID check, the
    // rule that refuses this probe.
    assert.deepEqual(requests[7]?.params, {
      server_id: '00000000-0000-0000-0000-000000000000',
      image: 'alpine:latest',
    });
  });

  it('propagates a missing response and sends no calls after the failed boundary', async () => {
    const { result, requests } = await runAgainst('verify-bridge-failure', (request) =>
      request.method === 'host_metrics' ? 'close' : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\(no response\)/);
    assert.deepEqual(
      requests.map((request) => request.method),
      ['ping', 'host_info', 'host_metrics'],
    );
  });

  it('fails without printing the body when a must-be-forbidden probe succeeds', async () => {
    const { result, requests } = await runAgainst('verify-bridge-open-allowlist', (request) =>
      request.method === 'file_read'
        ? { id: request.id, ok: true, result: { content: 'root:SECRET-SHADOW-HASH:19000' } }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /file_read.*expected a forbidden refusal/);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET-SHADOW-HASH/);
    assert.doesNotMatch(result.stdout, /done/);
    assert.equal(requests.at(-1)?.method, 'file_read');
  });

  it('fails when a probe is refused for a reason other than the allowlist', async () => {
    const { result } = await runAgainst('verify-bridge-wrong-code', (request) =>
      request.method === 'file_atomic_write'
        ? { id: request.id, ok: false, error: { code: 'runtime_error', message: 'disk full' } }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /file_atomic_write.*expected a forbidden refusal.*runtime_error/);
  });

  it('fails when container_run is refused by a rule other than the image allowlist', async () => {
    const { result } = await runAgainst('verify-bridge-wrong-rule', (request) =>
      request.method === 'container_run'
        ? {
            id: request.id,
            ok: false,
            error: { code: 'forbidden', message: 'forbidden: uuid "" is not a UUID' },
          }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /container_run.*not in allowlist/);
  });

  it('fails when a probe that must succeed returns an error', async () => {
    const { result, requests } = await runAgainst('verify-bridge-ping-error', (request) =>
      request.method === 'ping'
        ? { id: request.id, ok: false, error: { code: 'internal', message: 'boom' } }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ping.*expected ok.*internal/);
    assert.deepEqual(
      requests.map((request) => request.method),
      ['ping'],
    );
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

describe('infra hardening contracts (#47)', () => {
  const read = (relativePath: string) =>
    readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');

  it('install-host-bridge points the bridge backup RPCs at the deploy directory and its compose file', () => {
    const installer = read('scripts/install-host-bridge.sh');
    const dropIn = installer.slice(
      installer.indexOf('panel-host-bridge.service.d/install.conf" <<EOF'),
    );
    assert.match(dropIn, /\nEnvironment=PANEL_COMPOSE_DIR=\$\{REPO_DIR\}\n/);
    assert.match(dropIn, /\nEnvironment=PANEL_COMPOSE_FILE=\$\{PANEL_COMPOSE_FILE\}\n/);
    assert.match(dropIn, /\nEnvironment=PANEL_COMPOSE_ENV_FILES=\$\{PANEL_COMPOSE_ENV_FILES\}\n/);
    assert.match(installer, /PANEL_COMPOSE_FILE="\$\{PANEL_COMPOSE_FILE:-docker\/compose\.yml\}"/);
    assert.match(installer, /PANEL_COMPOSE_ENV_FILES="\$\{PANEL_COMPOSE_ENV_FILES:-\.env\}"/);
  });

  it('install-host-bridge creates the media directory the api and media-publisher bind', () => {
    const installer = read('scripts/install-host-bridge.sh');
    assert.match(installer, /"\$\{DATA_DIR\}\/media" \\/);
  });

  it('bootstrap generates the restic password and the least-privilege database login', () => {
    const bootstrap = read('scripts/bootstrap.sh');
    const envBlock = bootstrap.slice(bootstrap.indexOf('cat > "${REPO}/.env" <<EOF'));
    assert.match(envBlock, /\nRESTIC_PASSWORD=\$\{RESTIC_PW\}\n/);
    assert.match(envBlock, /\nPANEL_DB_USER=panel_app\n/);
    assert.match(envBlock, /\nPANEL_DB_PASSWORD=\$\{APP_DB_PW\}\n/);
    assert.match(bootstrap, /RESTIC_PW=\$\(openssl rand -hex 32\)/);
    assert.match(bootstrap, /APP_DB_PW=\$\(openssl rand -hex 32\)/);
  });

  it('restore.sh loads the restored RDB into a one-off server that takes the redis password', () => {
    const restore = read('scripts/restore.sh');
    assert.match(
      restore,
      /redis-server --dir \/data --dbfilename dump\.rdb --appendonly no --save "" --requirepass "\$REDISCLI_AUTH" &/,
    );
  });
});

/**
 * `scripts/test-fullstack-down-v.sh` destroys the postgres/redis bind trees to
 * make the data loss real before restoring. It used to `rm -rf dir/* 2>/dev/null
 * || true`: a permission error, a mis-parsed quoted DATA_DIR or dot files left
 * the data in place and the run still printed PASS without a restore ever
 * being exercised. The helpers are extracted from the real script so the test
 * cannot drift from it.
 */
function fullstackHelpers(): string {
  const source = readFileSync(
    path.join(REPOSITORY_ROOT, 'scripts/test-fullstack-down-v.sh'),
    'utf8',
  );
  const helpers = ['resolve_data_dir', 'wipe_bind_dir'].map((name) => {
    const body = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm'))?.[0];
    assert.ok(body, `could not extract ${name}() from scripts/test-fullstack-down-v.sh`);
    return body;
  });
  return helpers.join('\n');
}

function fullstackHarness(root: string, body: string): string {
  const script = path.join(root, 'harness.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -Eeuo pipefail',
      'fail() { echo "FAIL: $*" >&2; exit 9; }',
      fullstackHelpers(),
      body,
    ].join('\n'),
    { mode: 0o755 },
  );
  return script;
}

describe('full-stack down -v data wipe', () => {
  it('removes regular and dot files and leaves the bind empty', () => {
    const root = temporaryRoot('fullstack-wipe');
    const bind = path.join(root, 'postgres');
    mkdirSync(path.join(bind, 'base'), { recursive: true });
    writeFileSync(path.join(bind, 'PG_VERSION'), '16');
    writeFileSync(path.join(bind, '.s.PGSQL.lock'), 'lock');
    writeFileSync(path.join(bind, 'base/1'), 'rows');
    const result = run('/bin/bash', [fullstackHarness(root, `wipe_bind_dir "${bind}"`)]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(bind), []);
  });

  it('fails when the bind directory does not exist', () => {
    const root = temporaryRoot('fullstack-wipe-missing');
    const result = run('/bin/bash', [
      fullstackHarness(root, `wipe_bind_dir "${path.join(root, 'absent')}"`),
    ]);
    assert.equal(result.status, 9);
    assert.match(result.stderr, /does not exist/);
  });

  it(
    'fails instead of passing when a file cannot be removed',
    { skip: process.getuid?.() === 0 ? 'root can delete anything' : false },
    () => {
      const root = temporaryRoot('fullstack-wipe-denied');
      const bind = path.join(root, 'redis');
      mkdirSync(path.join(bind, 'locked'), { recursive: true });
      writeFileSync(path.join(bind, 'locked/dump.rdb'), 'data');
      chmodSync(path.join(bind, 'locked'), 0o500);
      try {
        const result = run('/bin/bash', [fullstackHarness(root, `wipe_bind_dir "${bind}"`)]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /could not wipe/);
      } finally {
        chmodSync(path.join(bind, 'locked'), 0o700);
      }
    },
  );

  it('fails when the bind is still not empty after the wipe', () => {
    const root = temporaryRoot('fullstack-wipe-noop');
    const bind = path.join(root, 'postgres');
    mkdirSync(bind, { recursive: true });
    writeFileSync(path.join(bind, 'PG_VERSION'), '16');
    const shims = shimDirectory();
    executable(path.join(shims, 'find'), 'exit 0');
    const result = run('/bin/bash', [fullstackHarness(root, `wipe_bind_dir "${bind}"`)], {
      env: { PATH: `${shims}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 9);
    assert.match(result.stderr, /still not empty/);
  });

  it('strips quotes from DATA_DIR and resolves it against the repository', () => {
    const root = temporaryRoot('fullstack-data-dir');
    const cases: Array<[string, string]> = [
      ['DATA_DIR="./data"\n', path.join(root, 'data')],
      ["DATA_DIR='/srv/panel data'\n", '/srv/panel data'],
      ['OTHER=1\n', path.join(root, 'data')],
      ['DATA_DIR=./one\nDATA_DIR=/srv/two # host data\n', '/srv/two'],
    ];
    for (const [envFile, expected] of cases) {
      writeFileSync(path.join(root, '.env'), envFile);
      const result = run('/bin/bash', [
        fullstackHarness(root, `REPO="${root}"; resolve_data_dir "${path.join(root, '.env')}"`),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected, envFile);
    }
  });
});
