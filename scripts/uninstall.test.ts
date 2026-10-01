import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { copyScript, loggingShim, logLines, run, shimDirectory } from './test-helpers/ops.ts';

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
