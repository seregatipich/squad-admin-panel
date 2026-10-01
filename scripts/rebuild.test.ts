import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { copyScript, loggingShim, logLines, run, shimDirectory } from './test-helpers/ops.ts';

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
