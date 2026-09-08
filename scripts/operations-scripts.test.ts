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
  'scripts/configure-bss-sso-env.sh',
  'scripts/deploy-tk104.sh',
  'scripts/dev-deploy-tk104.sh',
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
      'scripts/configure-bss-sso-env.test.ts',
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

  it('runs script contracts after database setup and before package tests in pre-push', () => {
    const { root, script } = copyScript('scripts/pre-push-checklist.sh');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    executable(
      path.join(shims, 'git'),
      `if [[ "$*" == 'rev-parse --show-toplevel' ]]; then printf '%s\\n' ${JSON.stringify(root)}; exit 0; fi; exit 1`,
    );
    loggingShim(shims, 'gitleaks');
    loggingShim(shims, 'pnpm');

    const result = run('/bin/bash', [script], {
      cwd: root,
      env: {
        OPS_LOG: log,
        PATH: `${shims}:/usr/bin:/bin`,
        DATABASE_URL: 'postgres://isolated-test-database',
        TEST_DATABASE_URL: 'postgres://isolated-test-database',
        FULL: '1',
        SKIP_BUILD: '1',
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(logLines(log), [
      'pnpm|turbo|run|typecheck',
      'pnpm|exec|biome|check|.',
      'gitleaks|detect|--config|.gitleaks.toml|--no-banner|--redact|--exit-code|1|--log-opts|origin/dev..HEAD',
      'pnpm|test:scripts',
      'pnpm|test:cov',
      'pnpm|turbo|run|test:mutation',
    ]);
  });

  it('limits affected package tests to two simultaneous Turbo tasks by default', () => {
    const { root, script } = copyScript('scripts/pre-push-checklist.sh');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    executable(
      path.join(shims, 'git'),
      `if [[ "$*" == 'rev-parse --show-toplevel' ]]; then printf '%s\\n' ${JSON.stringify(root)}; exit 0; fi; exit 1`,
    );
    loggingShim(shims, 'gitleaks');
    loggingShim(shims, 'pnpm');

    const result = run('/bin/bash', [script], {
      cwd: root,
      env: {
        OPS_LOG: log,
        PATH: `${shims}:/usr/bin:/bin`,
        DATABASE_URL: 'postgres://isolated-test-database',
        TEST_DATABASE_URL: 'postgres://isolated-test-database',
        FULL: '0',
        SKIP_BUILD: '1',
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      logLines(log).includes('pnpm|turbo|run|test|--concurrency=2|--filter=...[origin/dev]'),
    );
  });

  it('blocks pre-push when an operation script contract fails', () => {
    const { root, script } = copyScript('scripts/pre-push-checklist.sh');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    executable(
      path.join(shims, 'git'),
      `if [[ "$*" == 'rev-parse --show-toplevel' ]]; then printf '%s\\n' ${JSON.stringify(root)}; exit 0; fi; exit 1`,
    );
    loggingShim(shims, 'gitleaks');
    loggingShim(shims, 'pnpm', `if [[ "$*" == 'test:scripts' ]]; then exit 37; fi; exit 0`);

    const result = run('/bin/bash', [script], {
      cwd: root,
      env: {
        OPS_LOG: log,
        PATH: `${shims}:/usr/bin:/bin`,
        DATABASE_URL: 'postgres://isolated-test-database',
        TEST_DATABASE_URL: 'postgres://isolated-test-database',
        FULL: '1',
        SKIP_BUILD: '1',
      },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /operations and verification script tests.*FAILED/);
    assert.ok(logLines(log).includes('pnpm|test:scripts'));
  });

  it('fails closed without a database and does not start DB-backed script contracts', () => {
    const { root, script } = copyScript('scripts/pre-push-checklist.sh');
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    executable(
      path.join(shims, 'git'),
      `if [[ "$*" == 'rev-parse --show-toplevel' ]]; then printf '%s\\n' ${JSON.stringify(root)}; exit 0; fi; exit 1`,
    );
    loggingShim(shims, 'gitleaks');
    loggingShim(shims, 'pnpm');

    const result = run('/bin/bash', [script], {
      cwd: root,
      env: {
        OPS_LOG: log,
        PATH: `${shims}:/usr/bin:/bin`,
        DATABASE_URL: '',
        TEST_DATABASE_URL: '',
        FULL: '1',
        SKIP_BUILD: '1',
      },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /tests — no DATABASE_URL and could not auto-provision/);
    assert.equal(logLines(log).includes('pnpm|test:scripts'), false);
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
      env: { OPS_LOG: log, APP_DIR: root, PATH: `${shims}:/usr/bin:/bin` },
    };
  }

  it('fails before Docker when the deployment environment file is absent', () => {
    const { root, script } = copyScript('scripts/deploy-tk104.sh');
    const result = run('/bin/bash', [script], { env: { APP_DIR: root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.tk104 is missing/);
  });

  it('preserves arguments and executes build, up, probe, then status', () => {
    const fixture = deployFixture();
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Deploy complete/);
    const commands = logLines(fixture.log);
    assert.deepEqual(
      commands.filter((line) => line.startsWith('docker|')),
      [
        'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|build',
        'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|up|-d|--remove-orphans',
        'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|ps|--format|{{.Service}} {{.Health}}',
        'docker|compose|--env-file|.env.tk104|-f|compose.tk104.yml|ps',
      ],
    );
    const curlIndex = commands.findIndex((line) => line.startsWith('curl|'));
    const statusIndex = commands.findLastIndex((line) => line.endsWith('|ps'));
    assert.ok(curlIndex > 1 && curlIndex < statusIndex);
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

  it('propagates build and HTTP-probe failures without announcing success', () => {
    const buildFixture = deployFixture();
    const buildFailure = run('/bin/bash', [buildFixture.script], {
      env: {
        ...buildFixture.env,
        FAIL_DOCKER_MATCH: 'compose --env-file .env.tk104 -f compose.tk104.yml build',
        FAIL_CODE: '47',
      },
    });
    assert.equal(buildFailure.status, 47);
    assert.equal(
      logLines(buildFixture.log).some((line) => line.includes('|up|-d|')),
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
    assert.match(sshPayload(fixture.log), /bash scripts\/deploy-tk104-web\.sh/);
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
    assert.match(sshPayload(fixture.log), /APP_VERSION='dev-deadbee'/);

    const dirty = devDeployFixture();
    run('/bin/bash', [dirty.script], {
      env: { ...dirty.env, GIT_SHA: 'deadbee', GIT_DIRTY: ' M apps/web/src/page.tsx' },
    });
    assert.match(sshPayload(dirty.log), /APP_VERSION='dev-deadbee-dirty'/);
  });

  it('rebuilds only the api container, without the migrator, for the api target', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'api'], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = sshPayload(fixture.log);
    assert.match(payload, /build api/);
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
    assert.match(sshPayload(fixture.log), /bash scripts\/deploy-tk104\.sh/);
  });

  it('rebuilds a single worker container by name, on the same no-deps path', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'worker-rcon'], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = sshPayload(fixture.log);
    assert.match(payload, /build worker-rcon/);
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
