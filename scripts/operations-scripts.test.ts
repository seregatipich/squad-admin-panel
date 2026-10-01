import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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

describe('new-test-db provisioning', () => {
  interface NewTestDbFixture {
    script: string;
    root: string;
    log: string;
    shims: string;
  }

  function newTestDbFixture(dotenv: string | null): NewTestDbFixture {
    const { root, script } = copyScript('scripts/new-test-db.sh');
    if (dotenv !== null) writeFileSync(path.join(root, '.env'), dotenv);
    const shims = shimDirectory();
    const log = path.join(root, 'ops.log');
    // `ps` lists NTD_CONTAINERS and the existence probe answers NTD_EXISTS, so each test
    // stages the docker host it needs without a real daemon.
    loggingShim(
      shims,
      'docker',
      [
        'case "$1" in',
        '  ps) for name in ${NTD_CONTAINERS:-}; do printf "%s\\n" "$name"; done ;;',
        '  exec) case "$*" in *-tAc*) [ "${NTD_EXISTS:-0}" = 1 ] && printf "1\\n" ;; esac ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'pnpm', 'printf \'migrate-url|%s\\n\' "$DATABASE_URL" >> "$OPS_LOG"');
    return { script, root, log, shims };
  }

  function provision(
    fixture: NewTestDbFixture,
    args: string[],
    env: NodeJS.ProcessEnv = {},
  ): CommandResult {
    return run('/bin/bash', [fixture.script, ...args], {
      env: {
        PATH: `${fixture.shims}:/usr/bin:/bin`,
        OPS_LOG: fixture.log,
        NTD_CONTAINERS: 'squad-admin-panel-postgres-1',
        PG_CONTAINER: '',
        PG_HOST: '',
        PG_PORT: '',
        PG_USER: '',
        REDIS_HOST: '',
        REDIS_PORT: '',
        POSTGRES_PASSWORD: '',
        REDIS_PASSWORD: '',
        POSTGRES_HOST_PORT: '',
        REDIS_HOST_PORT: '',
        COMPOSE_PROJECT_NAME: '',
        ...env,
      },
    });
  }

  const DOTENV = 'POSTGRES_PASSWORD="pgsecret"\nREDIS_PASSWORD=redissecret\n';
  const TWO_STACKS = 'squad-admin-panel-postgres-1 other-wt-postgres-1';

  it('prints DATABASE_URL, TEST_DATABASE_URL and an isolated TEST_REDIS_URL on stdout only', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3']);

    assert.equal(result.status, 0, result.stderr);
    // cksum("test_wave3") % 8 == 3, so the slug lands on Redis logical database 11.
    assert.equal(
      result.stdout,
      [
        "export DATABASE_URL='postgres://admin:pgsecret@127.0.0.1:5432/test_wave3'",
        "export TEST_DATABASE_URL='postgres://admin:pgsecret@127.0.0.1:5432/test_wave3'",
        "export TEST_REDIS_URL='redis://:redissecret@127.0.0.1:6379/11'",
        '',
      ].join('\n'),
    );
    assert.match(result.stderr, /creating database test_wave3/);
    assert.ok(
      logLines(fixture.log).includes(
        'migrate-url|postgres://admin:pgsecret@127.0.0.1:5432/test_wave3',
      ),
    );
  });

  it('keeps the Redis logical database inside 8..15 and stable per slug', () => {
    const fixture = newTestDbFixture(DOTENV);
    for (const slug of ['a', 'prepush_worktree-one', 'x'.repeat(90), 'Mixed Case/Slug']) {
      const first = provision(fixture, [slug]);
      const second = provision(fixture, [slug]);
      assert.equal(first.status, 0, first.stderr);
      const database = Number(/TEST_REDIS_URL='[^']*\/(\d+)'/.exec(first.stdout)?.[1]);
      assert.ok(database >= 8 && database <= 15, `${slug}: ${database}`);
      assert.equal(first.stdout, second.stdout, slug);
    }
  });

  it('takes the Postgres and Redis host ports from .env, and PG_PORT/REDIS_PORT win over it', () => {
    const fixture = newTestDbFixture(`${DOTENV}POSTGRES_HOST_PORT=15432\nREDIS_HOST_PORT=16379\n`);
    const fromDotenv = provision(fixture, ['wave3']);
    assert.equal(fromDotenv.status, 0, fromDotenv.stderr);
    assert.match(fromDotenv.stdout, /@127\.0\.0\.1:15432\/test_wave3'/);
    assert.match(fromDotenv.stdout, /@127\.0\.0\.1:16379\/11'/);

    const explicit = provision(fixture, ['wave3'], { PG_PORT: '25432', REDIS_PORT: '26379' });
    assert.match(explicit.stdout, /@127\.0\.0\.1:25432\/test_wave3'/);
    assert.match(explicit.stdout, /@127\.0\.0\.1:26379\/11'/);
  });

  it('fails without a REDIS_PASSWORD instead of exporting a Redis URL that cannot authenticate', () => {
    const fixture = newTestDbFixture('POSTGRES_PASSWORD=pgsecret\n');
    const result = provision(fixture, ['wave3']);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /REDIS_PASSWORD is empty or missing in \.env/);
  });

  it('refuses to pick a container when several postgres containers run', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3'], { NTD_CONTAINERS: TWO_STACKS });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /several postgres containers are running/);
    assert.match(result.stderr, /squad-admin-panel-postgres-1/);
    assert.match(result.stderr, /other-wt-postgres-1/);
    assert.match(result.stderr, /PG_CONTAINER/);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('docker|exec')),
      false,
    );
  });

  it('uses PG_CONTAINER when several postgres containers run', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3'], {
      NTD_CONTAINERS: TWO_STACKS,
      PG_CONTAINER: 'other-wt-postgres-1',
    });

    assert.equal(result.status, 0, result.stderr);
    const execs = logLines(fixture.log).filter((line) => line.startsWith('docker|exec'));
    assert.ok(execs.length >= 2);
    for (const line of execs) assert.match(line, /^docker\|exec\|other-wt-postgres-1\|/);
  });

  it('narrows several containers to the COMPOSE_PROJECT_NAME stack', () => {
    const fixture = newTestDbFixture(`${DOTENV}COMPOSE_PROJECT_NAME=other-wt\n`);
    const result = provision(fixture, ['wave3'], { NTD_CONTAINERS: TWO_STACKS });

    assert.equal(result.status, 0, result.stderr);
    for (const line of logLines(fixture.log).filter((entry) => entry.startsWith('docker|exec'))) {
      assert.match(line, /^docker\|exec\|other-wt-postgres-1\|/);
    }
  });

  it('fails clearly when no postgres container runs', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3'], { NTD_CONTAINERS: 'unrelated-redis-1' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no running postgres container found/);
  });

  it('prints the chosen container for --container and applies the same ambiguity check', () => {
    const fixture = newTestDbFixture(DOTENV);
    const single = provision(fixture, ['--container']);
    assert.equal(single.status, 0, single.stderr);
    assert.equal(single.stdout, 'squad-admin-panel-postgres-1\n');

    const ambiguous = provision(fixture, ['--container'], { NTD_CONTAINERS: TWO_STACKS });
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /several postgres containers are running/);
  });

  it('applies the same container choice to --drop', () => {
    const fixture = newTestDbFixture(DOTENV);
    const ambiguous = provision(fixture, ['--drop', 'wave3'], { NTD_CONTAINERS: TWO_STACKS });
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /several postgres containers are running/);

    const chosen = provision(fixture, ['--drop', 'wave3'], {
      NTD_CONTAINERS: TWO_STACKS,
      PG_CONTAINER: 'other-wt-postgres-1',
    });
    assert.equal(chosen.status, 0, chosen.stderr);
    assert.ok(
      logLines(fixture.log).some(
        (line) =>
          line.startsWith('docker|exec|other-wt-postgres-1|') &&
          line.includes('DROP DATABASE IF EXISTS "test_wave3" WITH (FORCE)'),
      ),
    );
  });
});
