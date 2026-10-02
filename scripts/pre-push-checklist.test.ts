import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  type CommandResult,
  copyScript,
  executable,
  loggingShim,
  logLines,
  REPOSITORY_ROOT,
  run,
  shimDirectory,
  temporaryRoot,
} from './test-helpers/ops.ts';

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
      assert.match(result.stdout, /skipped — this push does not update dev/);
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
      'pnpm|exec|biome|check|apps|packages|scripts|docker/rnsquadjs|--error-on-warnings',
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

  it('treats a worker whose tests run the shared contract as DB-backed', () => {
    // The shared worker contract starts the worker against Redis and Postgres but the package's
    // own test files never name the variables, so the variable scan alone would run it without
    // a database and fail instead of skipping.
    const fixture = checklistFixture({
      ...FIXTURE_PACKAGES,
      'apps/workers/contract-worker': {
        'test/contract.test.ts':
          "import { workerContract } from '../../_test-shared/contract.js';\nworkerContract({});\n",
      },
    });
    const result = runChecklist(fixture, {
      packages: [
        PLAIN_PACKAGE,
        { name: '@fixture/contract-worker', path: 'apps/workers/contract-worker' },
      ],
      env: { DATABASE_URL: '', TEST_DATABASE_URL: '' },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      checklistCommands(fixture).some((line) => line.includes('--filter=@fixture/contract-worker')),
      false,
      'the contract worker must not be tested without a database',
    );
    assert.match(
      result.stdout,
      /DB-backed package tests — skipped \(no database: @fixture\/contract-worker\)/,
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
    assert.ok(commands.includes('pnpm|--filter|@squad/api|test:unit'));
    assert.match(
      result.stdout,
      /api DB-backed tests — skipped \(no database: test\/players\.test\.ts\)/,
    );
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

  describe('apps/api tests', () => {
    const UNIT_SET = 'pnpm|--filter|@squad/api|test:unit';
    const noDatabase = { DATABASE_URL: '', TEST_DATABASE_URL: '' };
    const runsVitest = (commands: string[]) =>
      commands.some((line) => line.startsWith('pnpm|turbo|run|test') || line.includes('vitest'));

    it('runs the service-free set, not a skip, when api changed and no database is available', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, {
        packages: [API_PACKAGE],
        changed: ['apps/api/src/routes/players.ts', 'apps/api/test/players.test.ts'],
        env: noDatabase,
      });

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const commands = checklistCommands(fixture);
      assert.ok(commands.includes(UNIT_SET), 'the service-free set must run');
      assert.equal(runsVitest(commands), false, 'no touched file may run without a database');
      assert.match(result.stdout, /✓ api tests \(service-free set\)/);
      assert.match(
        result.stdout,
        /api DB-backed tests — skipped \(no database: test\/players\.test\.ts\)/,
      );
    });

    it('runs the service-free set for an api source change with no test file touched', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, {
        packages: [API_PACKAGE],
        changed: ['apps/api/src/routes/players.ts', 'apps/api/test/helpers/players.ts'],
        env: noDatabase,
      });

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const commands = checklistCommands(fixture);
      assert.ok(commands.includes(`pnpm|turbo|run|typecheck|--filter=...[${MERGE_BASE}]`));
      assert.ok(commands.includes(UNIT_SET));
      assert.equal(runsVitest(commands), false);
      assert.doesNotMatch(result.stdout, /api DB-backed tests — skipped/);
    });

    it('runs only the touched files, not the service-free set, when a database is available', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, {
        packages: [API_PACKAGE],
        changed: ['apps/api/src/routes/players.ts', 'apps/api/test/players.test.ts'],
      });

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const commands = checklistCommands(fixture);
      assert.ok(
        commands.includes(
          'pnpm|--filter|@squad/api|exec|vitest|run|--passWithNoTests|test/players.test.ts',
        ),
      );
      assert.equal(commands.includes(UNIT_SET), false);
    });

    it('runs no api test at all when apps/api did not change', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, {
        packages: [PLAIN_PACKAGE],
        changed: ['packages/plain/src/index.ts'],
        env: noDatabase,
      });

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const commands = checklistCommands(fixture);
      assert.equal(commands.includes(UNIT_SET), false);
      assert.equal(
        commands.some((line) => line.includes('vitest')),
        false,
      );
      assert.doesNotMatch(result.stdout, /api (DB-backed )?tests/);
    });

    it('blocks the push when the service-free set fails', () => {
      const fixture = checklistFixture(FIXTURE_PACKAGES);
      const result = runChecklist(fixture, {
        packages: [API_PACKAGE],
        changed: ['apps/api/src/routes/players.ts'],
        env: { ...noDatabase, FAKE_FAIL_ON: '--filter @squad/api test:unit' },
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /✗ api tests \(service-free set\) FAILED/);
    });
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
      'pnpm|exec|biome|check|apps|packages|scripts|docker/rnsquadjs|--error-on-warnings',
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
      'pnpm|exec|biome|check|.|--error-on-warnings',
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
