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
  symlinkSync,
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
  'scripts/dev-deploy-tk104.sh',
  'scripts/rollback-tk104.sh',
  'scripts/tk104-deploy-entry.sh',
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

const IMAGE_REPO = 'ghcr.io/seregatipich/squad-panel';
const RELEASE_SHA = 'a'.repeat(40);
const NEXT_SHA = 'c'.repeat(40);
const IMAGES = [
  ['API_IMAGE', 'api'],
  ['WEB_IMAGE', 'web'],
  ['WORKERS_IMAGE', 'workers'],
  ['CADDY_IMAGE', 'caddy-tk104'],
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
  const { root, script } = copyScript('scripts/deploy-tk104.sh');
  writeFileSync(path.join(root, '.env.tk104'), 'SAFE_TEST_VALUE=1\n');
  writeFileSync(path.join(root, 'compose.tk104.yml'), 'services: {}\n');
  mkdirSync(path.join(root, 'docker'));
  writeFileSync(path.join(root, 'docker/Caddyfile.tk104'), 'tk104.duckdns.org {}\n');
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
): CommandResult {
  rmSync(fixture.log, { force: true });
  rmSync(`${fixture.log}.curl-attempts`, { force: true });
  return run('/bin/bash', [script], { env: { ...fixture.env, ...env } });
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
  'docker|compose|--env-file|.env.tk104|--env-file|.release.next.env|-f|compose.tk104.yml';

describe('tk104 release deploy', () => {
  it('fails before Docker when the deployment environment file is absent', () => {
    const { root, script } = copyScript('scripts/deploy-tk104.sh');
    const result = run('/bin/bash', [script], { env: { APP_DIR: root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.tk104 is missing/);
  });

  it('refuses a malformed release or image reference before any Docker call', () => {
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
      const result = deploy(fixture, env);
      assert.equal(result.status, 1, JSON.stringify(env));
      assert.match(result.stderr, message);
      assert.deepEqual(logLines(fixture.log), [], JSON.stringify(env));
    }
    assert.equal(existsSync(path.join(fixture.root, 'pwned')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('refuses a Compose too old to merge both env files, before changing anything', () => {
    for (const version of ['2.16.0', 'v1.29.2', '']) {
      const fixture = deployFixture();
      const result = deploy(fixture, { DOCKER_COMPOSE_VERSION: version });
      assert.equal(result.status, 1, version);
      assert.match(result.stderr, /Docker Compose 2\.17\+ is required/);
      assert.deepEqual(logLines(fixture.log), ['docker|compose|version|--short']);
      assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
    }
  });

  it('first release: pulls every image, backs up and migrates, starts, waits, records', () => {
    const fixture = deployFixture();
    const result = deploy(fixture, {
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
  });

  it('exits before any Docker call when a release changes no image and no configuration', () => {
    const fixture = deployFixture();
    assert.equal(deploy(fixture).status, 0);
    const first = releaseFile(fixture);

    const result = deploy(fixture, { RELEASE_SHA: NEXT_SHA });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changes no image and no configuration: nothing to do/);
    assert.deepEqual(logLines(fixture.log), []);
    // The commit is recorded; the running api keeps reporting its own version.
    assert.deepEqual(releaseFile(fixture), { ...first, RELEASE_SHA: NEXT_SHA });
    assert.equal(existsSync(path.join(fixture.root, '.release.prev.env')), false);
  });

  it('pulls and recreates only what changed, keeping APP_VERSION while the api image stays', () => {
    const fixture = deployFixture();
    assert.equal(deploy(fixture).status, 0);
    const first = releaseFile(fixture);
    const webImage = imageRef('web', '2');

    const result = deploy(fixture, {
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

  it('reports the new commit once the api image changes', () => {
    const fixture = deployFixture();
    assert.equal(deploy(fixture).status, 0);
    const result = deploy(fixture, { RELEASE_SHA: NEXT_SHA, API_IMAGE: imageRef('api', '2') });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(releaseFile(fixture).APP_VERSION, NEXT_SHA);
    assert.match(result.stdout, new RegExp(`APP_VERSION=${NEXT_SHA}`));
  });

  it('backs up and migrates before the new containers start, only when drizzle changed', () => {
    const fixture = deployFixture();
    assert.equal(deploy(fixture).status, 0);
    mkdirSync(fixture.backups, { recursive: true });
    for (let day = 1; day <= 6; day += 1) {
      writeFileSync(path.join(fixture.backups, `panel-2020010${day}T000000Z-old.dump`), 'PGDMP');
    }
    writeFileSync(path.join(fixture.root, 'packages/db/drizzle/0001_next.sql'), 'ALTER TABLE t;\n');

    const result = deploy(fixture, { RELEASE_SHA: NEXT_SHA });
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

  it('stops before any app container is replaced when a migration fails', () => {
    const fixture = deployFixture();
    assert.equal(deploy(fixture).status, 0);
    const running = readFileSync(path.join(fixture.root, '.release.env'), 'utf8');
    writeFileSync(path.join(fixture.root, 'packages/db/drizzle/0001_next.sql'), 'ALTER TABLE t;\n');

    const result = deploy(fixture, {
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

  it('does not migrate when the pre-migration backup fails', () => {
    const fixture = deployFixture();
    const result = deploy(fixture, { FAIL_DOCKER_MATCH: 'pg_dump' });
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

  it('applies a Caddyfile or .env.tk104 edit even when no image changed', () => {
    for (const edited of ['docker/Caddyfile.tk104', '.env.tk104']) {
      const fixture = deployFixture();
      assert.equal(deploy(fixture).status, 0);
      const first = releaseFile(fixture);
      writeFileSync(path.join(fixture.root, edited), '# edited\n', { flag: 'a' });

      const result = deploy(fixture, { RELEASE_SHA: NEXT_SHA });
      assert.equal(result.status, 0, result.stderr);
      const commands = dockerCommands(fixture.log);
      assert.ok(commands.includes(`${COMPOSE}|up|-d|--remove-orphans`), edited);
      assert.equal(
        commands.some((line) => line.startsWith('docker|pull|') || line.includes('migrator')),
        false,
      );
      const recorded = releaseFile(fixture);
      const hash = edited === '.env.tk104' ? 'COMPOSE_CONFIG_SHA' : 'CADDYFILE_SHA';
      assert.notEqual(recorded[hash], first[hash], edited);
    }
  });

  it('fails closed when a recreated service never becomes ready, keeping the recorded release', () => {
    const fixture = deployFixture();
    assert.equal(deploy(fixture).status, 0);
    const running = readFileSync(path.join(fixture.root, '.release.env'), 'utf8');

    const result = deploy(fixture, {
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
  // was healthy and serving https://tk104.duckdns.org/health with a 200.
  it('retries the Caddy probe while TLS is still coming up, then reports success', () => {
    const fixture = deployFixture();
    const result = deploy(fixture, { CURL_FAIL_TIMES: '3', CURL_EXIT: '35' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /is live/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('curl|'));
    assert.equal(probes.length, 4, 'expected 3 failed probes then one success');
    assert.ok(probes.every((line) => line.includes('|--resolve|tk104.duckdns.org:443:127.0.0.1|')));
  });

  it('still fails closed, preserving the curl exit code, when the probe never recovers', () => {
    const fixture = deployFixture();
    const result = deploy(fixture, { CURL_EXIT: '35' });
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

  it('fails when /health keeps reporting a version other than the recorded one', () => {
    const fixture = deployFixture();
    const result = deploy(fixture, { CURL_VERSION: 'stale' });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`expected version ${RELEASE_SHA}, last response: .*"stale"`),
    );
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('propagates a failed start without probing or recording the release', () => {
    const fixture = deployFixture();
    const result = deploy(fixture, {
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

  it('builds the release on the host through the override when asked, never pulling', () => {
    const fixture = deployFixture();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = deploy(fixture, {
        DEPLOY_BUILD: '1',
        RELEASE_SHA: 'dev-abc1234',
        API_IMAGE: undefined,
        WEB_IMAGE: undefined,
        WORKERS_IMAGE: undefined,
        CADDY_IMAGE: undefined,
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = dockerCommands(fixture.log);
      // A rebuilt tag can hide new content, so a second identical run builds too.
      const build = commands.indexOf(`${COMPOSE}|-f|compose.tk104.build.yml|build`);
      const up = commands.indexOf(`${COMPOSE}|up|-d|--remove-orphans`);
      assert.ok(build >= 0 && up > build, commands.join('\n'));
      assert.equal(
        commands.some((line) => line.startsWith('docker|pull|')),
        false,
      );
    }
    const recorded = releaseFile(fixture);
    assert.equal(recorded.APP_VERSION, 'dev-abc1234');
    for (const [key, name] of IMAGES) {
      assert.equal(recorded[key], `${IMAGE_REPO}-${name}:dev-abc1234`);
    }
  });

  it('removes panel images other than the running and the previous release', () => {
    const fixture = deployFixture();
    const first = releaseImages('1');
    const second = releaseImages('1', { WEB_IMAGE: imageRef('web', '2') });
    const present = [...Object.values(first), second.WEB_IMAGE].join(',');
    const staleWeb = imageRef('web', '3');
    const staleApi = imageRef('api', '0');
    const repoIds = [...Object.values(first), second.WEB_IMAGE, staleWeb, staleApi]
      .map((reference) => `id:${reference}`)
      .join(',');
    assert.equal(deploy(fixture, { DOCKER_PRESENT: present }).status, 0);

    const result = deploy(fixture, {
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

describe('tk104 rollback', () => {
  /** A deploy fixture with the real rollback script next to the real deploy script. */
  function rollbackFixture(): DeployFixture & { rollback: string } {
    const fixture = deployFixture();
    const rollback = path.join(fixture.root, 'scripts/rollback-tk104.sh');
    copyFileSync(path.join(REPOSITORY_ROOT, 'scripts/rollback-tk104.sh'), rollback);
    return { ...fixture, rollback };
  }

  it('redeploys the previous release and swaps the release files, without migrating', () => {
    const fixture = rollbackFixture();
    assert.equal(deploy(fixture).status, 0);
    const first = releaseFile(fixture);
    const second = releaseImages('2');
    assert.equal(deploy(fixture, { ...second, RELEASE_SHA: NEXT_SHA }).status, 0);
    const current = releaseFile(fixture);
    assert.equal(current.APP_VERSION, NEXT_SHA);

    // Only the current images are still on the host: the previous ones are pulled.
    const result = deploy(
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
    assert.equal(deploy(fixture, {}, fixture.rollback).status, 0);
    assert.deepEqual(releaseFile(fixture), current);
  });

  it('refuses without a complete previous release, or onto the running one', () => {
    const empty = rollbackFixture();
    const none = deploy(empty, {}, empty.rollback);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no previous release recorded/);
    assert.deepEqual(logLines(empty.log), []);

    const partial = rollbackFixture();
    writeFileSync(path.join(partial.root, '.release.prev.env'), `RELEASE_SHA=${RELEASE_SHA}\n`);
    const incomplete = deploy(partial, {}, partial.rollback);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /records no API_IMAGE/);
    assert.deepEqual(logLines(partial.log), []);

    const same = rollbackFixture();
    assert.equal(deploy(same).status, 0);
    copyFileSync(path.join(same.root, '.release.env'), path.join(same.root, '.release.prev.env'));
    const onto = deploy(same, {}, same.rollback);
    assert.equal(onto.status, 1);
    assert.match(onto.stderr, /already the running release/);
    assert.deepEqual(logLines(same.log), []);
  });
});

describe('tk104 forced-command deploy entry', () => {
  const VALID = [
    'deploy',
    RELEASE_SHA,
    `api=sha256:${'1'.repeat(64)}`,
    `web=sha256:${'2'.repeat(64)}`,
    `workers=sha256:${'3'.repeat(64)}`,
    `caddy-tk104=sha256:${'4'.repeat(64)}`,
  ].join(' ');

  function entryFixture(): {
    root: string;
    script: string;
    log: string;
    src: string;
    app: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/tk104-deploy-entry.sh');
    const src = path.join(root, 'src');
    const app = path.join(root, 'app');
    // rsync is a shim, so the synced tree is prepared by hand; its deploy
    // script is a stand-in recording what the entry handed over.
    mkdirSync(path.join(app, 'scripts'), { recursive: true });
    executable(
      path.join(app, 'scripts/deploy-tk104.sh'),
      `printf 'deploy|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$PWD" "$APP_DIR" "$RELEASE_SHA" "$API_IMAGE" "$WEB_IMAGE" "$WORKERS_IMAGE" "$CADDY_IMAGE" "\${DEPLOY_BUILD:-unset}" >> "\${OPS_LOG:?}"`,
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

  it('refuses anything but the exact deploy request, before git, rsync or the deploy', () => {
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
      VALID.replace('caddy-tk104=', 'caddy='),
      VALID.replace('deploy ', 'rollback '),
    ];
    for (const request of requests) {
      const result = run('/bin/bash', [fixture.script], {
        env: { ...fixture.env, SSH_ORIGINAL_COMMAND: request },
      });
      assert.equal(result.status, 2, JSON.stringify(request));
      assert.match(result.stderr, /^refused: expected 'deploy <40-hex sha> api=sha256:/);
      assert.deepEqual(logLines(fixture.log), [], JSON.stringify(request));
    }
    const bare = run('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(bare.status, 2);
    // A forced command's request always wins over arguments.
    const smuggled = run('/bin/bash', [fixture.script, ...VALID.split(' ')], {
      env: { ...fixture.env, SSH_ORIGINAL_COMMAND: 'rollback' },
    });
    assert.equal(smuggled.status, 2);
    assert.deepEqual(logLines(fixture.log), []);
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(fixture.src), false);
  });

  it('fetches the commit, syncs it without host state, and hands over to its deploy script', () => {
    const fixture = entryFixture();
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, SSH_ORIGINAL_COMMAND: VALID, DEPLOY_BUILD: '1' },
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
        imageRef('caddy-tk104', '4'),
        // A request can only ever deploy registry images, never build.
        'unset',
      ].join('|'),
    ]);
    // No installed copy exists in the fixture's checkout, so it says to reinstall.
    assert.match(result.stderr, /differs from scripts\/tk104-deploy-entry\.sh .* reinstall it/);
  });

  it('takes the same request as arguments when run by hand, with overridable locations', () => {
    const fixture = entryFixture();
    mkdirSync(path.join(fixture.src, '.git'), { recursive: true });
    mkdirSync(path.join(fixture.src, 'scripts'), { recursive: true });
    copyFileSync(fixture.script, path.join(fixture.src, 'scripts/tk104-deploy-entry.sh'));
    const result = run('/bin/bash', [fixture.script, ...VALID.split(' ')], {
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

  it('stops before syncing when the commit cannot be fetched or checked out', () => {
    const unfetchable = entryFixture();
    const fetchFailure = run('/bin/bash', [unfetchable.script], {
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
    const wrongHead = run('/bin/bash', [elsewhere.script], {
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

  /** The remote command: every ssh argument after the target, which may itself contain `|`. */
  function sshPayload(log: string): string {
    return logLines(log)
      .filter((line) => line.startsWith('ssh|'))
      .map((line) => line.split('|').slice(6).join('|'))
      .join('\n');
  }

  const COMPOSE_BOTH =
    'docker compose --env-file .env.tk104 --env-file .release.env -f compose.tk104.yml';

  it('defaults to the web service: rebuilds it on the host after the sync and records it', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const commands = logLines(fixture.log);
    const rsyncIndex = commands.findIndex((line) => line.startsWith('rsync|'));
    const sshIndex = commands.findIndex((line) => line.startsWith('ssh|'));
    assert.ok(rsyncIndex >= 0 && sshIndex > rsyncIndex, commands.join('\n'));
    const payload = sshPayload(fixture.log);
    const image = `${IMAGE_REPO}-web:dev-abc1234`;
    assert.match(
      payload,
      /test -f \.release\.env \|\| \{ echo 'fatal: tk104 has no release recorded yet/,
    );
    assert.ok(payload.includes(`export WEB_IMAGE='${image}';`), payload);
    assert.ok(payload.includes(`${COMPOSE_BOTH} -f compose.tk104.build.yml build web;`), payload);
    assert.ok(payload.includes(`${COMPOSE_BOTH} up -d --no-deps web;`), payload);
    assert.ok(
      payload.includes(`sed -i -e 's|^WEB_IMAGE=.*|WEB_IMAGE=${image}|' .release.env`),
      payload,
    );
    // Nothing that could touch the schema, other containers, or /health.
    assert.doesNotMatch(payload, /deploy-tk104|migrator|--remove-orphans|APP_VERSION/);
  });

  it('never ships host secrets, release records, state, or build output', () => {
    const fixture = devDeployFixture();
    run('/bin/bash', [fixture.script], { env: fixture.env });
    const rsync = logLines(fixture.log).find((line) => line.startsWith('rsync|')) ?? '';
    for (const excluded of [
      '.git',
      'node_modules',
      '.next',
      'data',
      'dist',
      '.env',
      '.env.*',
      '.release*',
    ]) {
      assert.ok(rsync.includes(`|--exclude|${excluded}`), `${excluded} is not excluded: ${rsync}`);
    }
    assert.ok(rsync.includes('|--delete'), rsync);
    assert.match(rsync, /\|seregatipich@tk104\.duckdns\.org:apps\/squad-admin-panel\/$/);
  });

  it('stamps a version that can never be mistaken for a pushed commit SHA', () => {
    const fixture = devDeployFixture();
    run('/bin/bash', [fixture.script, 'api'], { env: { ...fixture.env, GIT_SHA: 'deadbee' } });
    assert.ok(
      sshPayload(fixture.log).includes(
        `export API_IMAGE='${IMAGE_REPO}-api:dev-deadbee' APP_VERSION='dev-deadbee';`,
      ),
      sshPayload(fixture.log),
    );

    const dirty = devDeployFixture();
    run('/bin/bash', [dirty.script, 'api'], {
      env: { ...dirty.env, GIT_SHA: 'deadbee', GIT_DIRTY: ' M apps/web/src/page.tsx' },
    });
    assert.match(sshPayload(dirty.log), /APP_VERSION='dev-deadbee-dirty'/);
  });

  it('rebuilds only the api container, without the migrator, and records its version', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'api'], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = sshPayload(fixture.log);
    assert.ok(payload.includes(`${COMPOSE_BOTH} -f compose.tk104.build.yml build api;`), payload);
    assert.ok(payload.includes(`${COMPOSE_BOTH} up -d --no-deps api;`), payload);
    assert.ok(
      payload.includes(
        `sed -i -e 's|^API_IMAGE=.*|API_IMAGE=${IMAGE_REPO}-api:dev-abc1234|' -e 's|^APP_VERSION=.*|APP_VERSION=dev-abc1234|' .release.env`,
      ),
      payload,
    );
    assert.doesNotMatch(payload, /migrator|--remove-orphans/);
  });

  it('refuses the full deploy without the explicit confirmation, before any sync', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'full'], { env: fixture.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /migrations from the working tree/);
    assert.deepEqual(logLines(fixture.log), []);
  });

  it('runs the whole deploy as a host build once the confirmation is exact', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'full'], {
      env: { ...fixture.env, CONFIRM_FULL_DEPLOY: 'deploy' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      sshPayload(fixture.log),
      /DEPLOY_BUILD=1 RELEASE_SHA='dev-abc1234' bash scripts\/deploy-tk104\.sh$/,
    );
  });

  it('rebuilds a single worker container by name, on the same no-deps path', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script, 'worker-rcon'], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = sshPayload(fixture.log);
    assert.ok(
      payload.includes(`export WORKERS_IMAGE='${IMAGE_REPO}-workers:dev-abc1234';`),
      payload,
    );
    assert.ok(payload.includes('-f compose.tk104.build.yml build worker-rcon;'), payload);
    assert.ok(payload.includes('up -d --no-deps worker-rcon;'), payload);
    assert.doesNotMatch(payload, /migrator|--remove-orphans|APP_VERSION/);
  });

  it('rejects an unknown or malformed target before touching tk104', () => {
    for (const target of ['postgres', 'worker-rcon;touch pwned', 'worker-', 'worker-RCON']) {
      const fixture = devDeployFixture();
      const result = run('/bin/bash', [fixture.script, target], { env: fixture.env });
      assert.equal(result.status, 2, target);
      assert.match(result.stderr, /usage: dev-deploy-tk104\.sh \[web\|api\|worker-<name>\|full\]/);
      assert.deepEqual(logLines(fixture.log), [], target);
    }
  });

  it('stops at a failed sync instead of rebuilding a half-copied tree', () => {
    const fixture = devDeployFixture();
    const result = run('/bin/bash', [fixture.script], {
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
