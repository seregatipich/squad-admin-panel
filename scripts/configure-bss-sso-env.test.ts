import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'scripts/configure-bss-sso-env.sh');
const SECRET = 'shared-secret-with-at-least-thirty-two-characters';
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'panel-sso-env '));
  roots.push(root);
  return root;
}

function run(root: string, input: string) {
  return spawnSync('/bin/bash', [SCRIPT], {
    env: { ...process.env, APP_DIR: root },
    input,
    encoding: 'utf8',
  });
}

after(() => {
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe('configure-bss-sso-env.sh', () => {
  it('is wired once between sync and the full production build', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const sync = workflow.indexOf('name: Sync repository to tk104');
    const configure = workflow.indexOf('name: Configure BSS SSO settings');
    const build = workflow.indexOf('name: Build and restart the stack on tk104');

    assert.ok(sync >= 0 && configure > sync && build > configure);
    assert.equal(workflow.match(/secrets\.BSS_SSO_SHARED_SECRET/g)?.length, 1);
    assert.match(workflow.slice(configure, build), /printf '%s'/);
    assert.match(workflow.slice(configure, build), /bash scripts\/configure-bss-sso-env\.sh/);
  });

  it('keeps the one-time session cutover exact and restarts the API on failure', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const cutover = workflow.slice(workflow.indexOf('revoke-sessions-for-sso-cutover:'));

    assert.match(cutover, /github\.event\.inputs\.expected_sha == github\.sha/);
    assert.match(cutover, /trap restart_api EXIT/);
    assert.match(cutover, /stop api/);
    assert.match(cutover, /revoke-sessions-for-sso-cutover\.js/);
    assert.match(cutover, /--confirm-all-sessions/);
    assert.ok((workflow.match(/name: Remove SSH deploy key/g) ?? []).length === 3);
  });

  it('atomically changes only the four SSO settings and never prints the secret', () => {
    const root = temporaryRoot();
    const envFile = path.join(root, '.env.tk104');
    writeFileSync(
      envFile,
      "POSTGRES_PASSWORD='keep-byte-for-byte'\nBSS_SSO_CLIENT_ID=old\nUNKNOWN=keep\n",
      { mode: 0o600 },
    );

    const result = run(root, SECRET);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SECRET));
    assert.equal(
      readFileSync(envFile, 'utf8'),
      "POSTGRES_PASSWORD='keep-byte-for-byte'\n" +
        'BSS_SSO_CLIENT_ID=squad-admin-panel\n' +
        'UNKNOWN=keep\n' +
        'BSS_SITE_URL=https://bss.games\n' +
        `BSS_SSO_CLIENT_SECRET=${SECRET}\n` +
        'BSS_SSO_CLIENT_SECRET_NEXT=\n',
    );
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
  });

  it('refuses an unsafe secret without changing the file', () => {
    const root = temporaryRoot();
    const envFile = path.join(root, '.env.tk104');
    const original = 'POSTGRES_PASSWORD=keep\n';
    writeFileSync(envFile, original, { mode: 0o640 });

    const result = run(root, 'short');

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(envFile, 'utf8'), original);
    assert.equal(statSync(envFile).mode & 0o777, 0o640);
  });

  it('refuses duplicate managed keys and symbolic-link targets', () => {
    const duplicateRoot = temporaryRoot();
    const duplicateFile = path.join(duplicateRoot, '.env.tk104');
    const duplicate = 'BSS_SITE_URL=one\nBSS_SITE_URL=two\n';
    writeFileSync(duplicateFile, duplicate, { mode: 0o600 });
    const duplicateResult = run(duplicateRoot, SECRET);
    assert.notEqual(duplicateResult.status, 0);
    assert.equal(readFileSync(duplicateFile, 'utf8'), duplicate);

    const symlinkRoot = temporaryRoot();
    const realFile = path.join(symlinkRoot, 'real.env');
    writeFileSync(realFile, 'POSTGRES_PASSWORD=keep\n', { mode: 0o600 });
    symlinkSync(realFile, path.join(symlinkRoot, '.env.tk104'));
    const symlinkResult = run(symlinkRoot, SECRET);
    assert.notEqual(symlinkResult.status, 0);
    assert.equal(readFileSync(realFile, 'utf8'), 'POSTGRES_PASSWORD=keep\n');
  });
});
