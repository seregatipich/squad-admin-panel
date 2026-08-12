import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
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

function logLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

after(() => {
  for (const root of temporaryRoots.reverse()) rmSync(root, { recursive: true, force: true });
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
    loggingShim(shims, 'curl', `exit "\${CURL_EXIT:-0}"`);
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
