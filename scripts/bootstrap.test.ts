import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  copyScript,
  executable,
  loggingShim,
  logLines,
  REPOSITORY_ROOT,
  run,
  shimDirectory,
} from './test-helpers/ops.ts';

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
