import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPOSITORY_ROOT, run } from './test-helpers/ops.ts';

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
    // The compose, Dockerfile and dependency contracts under scripts/infra-contracts
    // are vitest suites that read repository files and need no database.
    assert.match(testScripts, /vitest run --root scripts\/infra-contracts/);
    for (const testFile of [
      'scripts/deploy-workflow.test.ts',
      'scripts/bootstrap.test.ts',
      'scripts/deploy-stand.test.ts',
      'scripts/deploy-entry.test.ts',
      'scripts/rebuild.test.ts',
      'scripts/restore.test.ts',
      'scripts/uninstall.test.ts',
      'scripts/verify-bridge.test.ts',
      'scripts/backup-restore-wait-pg.test.ts',
      'scripts/full-stack-down.test.ts',
      'scripts/new-test-db.test.ts',
      'scripts/pre-push-checklist.test.ts',
      'scripts/static-contracts.test.ts',
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
