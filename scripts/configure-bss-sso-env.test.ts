import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'scripts/configure-bss-sso-env.sh');
const SECRET = 'shared-secret-with-at-least-thirty-two-characters';
const VIP_SECRET = createHmac('sha256', SECRET).update('bss-vip-lifecycle-v1').digest('hex');
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'panel-sso-env '));
  roots.push(root);
  return root;
}

function run(root: string, input: string, extraEnvironment: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/bash', [SCRIPT], {
    env: { ...process.env, APP_DIR: root, ...extraEnvironment },
    input,
    encoding: 'utf8',
  });
}

function expectedManaged(): string {
  return (
    'BSS_SITE_URL=https://bss.games\n' +
    'BSS_SSO_CLIENT_ID=squad-admin-panel\n' +
    `BSS_SSO_CLIENT_SECRET=${SECRET}\n` +
    'BSS_SSO_CLIENT_SECRET_NEXT=\n' +
    `VIP_LIFECYCLE_WEBHOOK_SECRET=${VIP_SECRET}\n` +
    'VIP_LIFECYCLE_REQUIRE_REVISION=false\n'
  );
}

after(() => {
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe('configure-bss-sso-env.sh', () => {
  it('fails a manual full deploy before checkout unless it targets the exact master SHA', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const start = workflow.indexOf('  deploy:');
    const end = workflow.indexOf('  deploy-web-preview:');
    const deploy = workflow.slice(start, end);
    const guard = deploy.indexOf('name: Verify exact master revision');
    const checkout = deploy.indexOf('uses: actions/checkout');

    assert.ok(start >= 0 && end > start);
    assert.ok(guard >= 0 && checkout > guard);
    assert.match(deploy, /GITHUB_REF.*refs\/heads\/master/);
    assert.match(deploy, /GITHUB_EVENT_NAME.*workflow_dispatch/);
    assert.match(deploy, /PANEL_EXPECTED_SHA.*GITHUB_SHA/);
    assert.match(deploy, /PANEL_EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/);
  });

  it('pins tk104 SSH trust before full deploy and VIP secret transport', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const full = workflow.slice(
      workflow.indexOf('  deploy:'),
      workflow.indexOf('  deploy-web-preview:'),
    );
    const vip = workflow.slice(workflow.indexOf('  configure-vip-revision-mode:'));

    assert.doesNotMatch(workflow, /ssh-keyscan|StrictHostKeyChecking=accept-new/);
    assert.equal(
      (workflow.match(/name: Configure pinned SSH trust and deploy key/g) ?? []).length,
      5,
    );

    for (const [section, expectedConnections] of [
      [full, 3],
      [vip, 5],
    ] as const) {
      assert.doesNotMatch(section, /ssh-keyscan|StrictHostKeyChecking=accept-new/);
      assert.match(section, /TK104_SSH_KNOWN_HOSTS: \$\{\{ secrets\.TK104_SSH_KNOWN_HOSTS \}\}/);
      assert.ok(
        section.indexOf('TK104_SSH_KNOWN_HOSTS:') <
          section.indexOf(`BSS_SSO_SHARED_SECRET: \${{ secrets.BSS_SSO_SHARED_SECRET }}`),
      );
      assert.match(section, /if \[\[ -z "\$\{TK104_SSH_KNOWN_HOSTS\}" \]\]; then/);
      assert.match(section, /ssh-keygen -l -f/);
      assert.match(section, /ssh-keygen -F tk104\.duckdns\.org -f/);
      assert.match(section, /chmod 600 "\$\{RUNNER_TEMP\}\/tk104_known_hosts"/);
      assert.equal((section.match(/StrictHostKeyChecking=yes/g) ?? []).length, expectedConnections);
      assert.equal((section.match(/UserKnownHostsFile=/g) ?? []).length, expectedConnections);
      assert.match(section, /rm -f ~\/\.ssh\/id_deploy "\$\{RUNNER_TEMP\}\/tk104_known_hosts"/);
    }
  });

  it('is wired once between sync and the full production build', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const sync = workflow.indexOf('name: Sync repository to tk104');
    const configure = workflow.indexOf('name: Configure BSS SSO settings');
    const build = workflow.indexOf('name: Build and restart the stack on tk104');

    assert.ok(sync >= 0 && configure > sync && build > configure);
    assert.equal(
      workflow.slice(configure, build).match(/secrets\.BSS_SSO_SHARED_SECRET/g)?.length,
      1,
    );
    assert.match(workflow.slice(configure, build), /printf '%s'/);
    assert.match(workflow.slice(configure, build), /PANEL_RELEASE_SHA_DESIRED/);
    assert.match(workflow.slice(configure, build), /bash scripts\/configure-bss-sso-env\.sh/);
    assert.match(workflow, /\.version == \$revision/);
  });

  it('keeps the one-time session cutover exact and restarts the API on failure', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const start = workflow.indexOf('revoke-sessions-for-sso-cutover:');
    const end = workflow.indexOf('configure-vip-revision-mode:');
    const cutover = workflow.slice(start, end);
    const jobCondition = cutover.slice(0, cutover.indexOf('runs-on:'));
    const guard = cutover.indexOf('name: Verify exact master revision for SSO cutover');
    const ssh = cutover.indexOf('name: Configure pinned SSH trust and deploy key');

    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(jobCondition, /github\.(?:ref|sha)|expected_sha/);
    assert.ok(guard >= 0 && ssh > guard);
    assert.match(cutover, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/);
    assert.match(cutover, /GITHUB_REF.*refs\/heads\/master/);
    assert.match(cutover, /EXPECTED_SHA.*GITHUB_SHA/);
    assert.match(cutover, /trap restart_api EXIT/);
    assert.match(cutover, /stop api/);
    assert.match(cutover, /revoke-sessions-for-sso-cutover\.js/);
    assert.match(cutover, /--confirm-all-sessions/);
    assert.match(cutover, /name: External health check\n\s+if: always\(\)/);
    assert.ok((workflow.match(/name: Remove SSH deploy key/g) ?? []).length === 5);
    assert.equal((workflow.match(/^\s+runs-on:/gmu) ?? []).length, 5);
    assert.equal((workflow.match(/runs-on:\n\s+group: selfhost-group-1/g) ?? []).length, 5);
  });

  it('changes strict VIP revision mode only for exact deployed panel and site revisions', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const start = workflow.indexOf('configure-vip-revision-mode:');
    const section = workflow.slice(start);

    assert.ok(start >= 0);
    assert.match(section, /target == 'vip-revision-cutover'/);
    assert.match(section, /name: Verify exact panel revision/);
    assert.match(section, /"\$\{GITHUB_REF\}" != "refs\/heads\/master"/);
    assert.match(section, /"\$\{PANEL_EXPECTED_SHA\}" != "\$\{GITHUB_SHA\}"/);
    assert.match(section, /SITE_EXPECTED_SHA: \$\{\{ inputs\.site_expected_sha \}\}/);
    assert.match(section, /https:\/\/bss\.games\/readyz/);
    assert.match(section, /\.revision == \$revision/);
    assert.match(section, /\.vip_guaranteed_activation_enabled == false/);
    assert.match(section, /\.version == \$revision/);
    assert.match(section, /VIP_LIFECYCLE_REQUIRE_REVISION=\$\{revision_mode\}/);
    assert.match(section, /VIP_LIFECYCLE_WEBHOOK_SECRET=\$\{expected_vip_secret\}/);
    assert.match(section, /previous_revision_mode/);
    assert.match(section, /rollback/);
    assert.match(section, /tar -xzf -/);
    assert.match(section, /VIP_LIFECYCLE_REQUIRE_REVISION_DESIRED/);
    assert.match(section, /bash "\$\{release_dir\}\/scripts\/configure-bss-sso-env\.sh"/);
    assert.match(section, /--project-name squad-admin-panel/);
    assert.match(section, /dist\/tools\/audit-vip-lifecycle-ownership\.js/);
    assert.match(
      section,
      /if \[ "\$\{revision_mode\}" = "true" \]; then[\s\S]*VIP_LIFECYCLE_FENCE_ACTION=enable[\s\S]*audit-vip-lifecycle-ownership\.js[\s\S]*fi/,
    );
    assert.match(
      section,
      /if \[ "\$\{revision_mode\}" = "false" \]; then[\s\S]*stop api[\s\S]*VIP_LIFECYCLE_FENCE_ACTION=disable[\s\S]*run --rm --no-deps -T[\s\S]*audit-vip-lifecycle-ownership\.js[\s\S]*fi/,
    );
    assert.match(
      section,
      /if ! VIP_LIFECYCLE_FENCE_ACTION=disable[\s\S]*audit-vip-lifecycle-ownership\.js; then[\s\S]*VIP_LIFECYCLE_REQUIRE_REVISION_DESIRED=true[\s\S]*configure-bss-sso-env\.sh[\s\S]*up -d --no-deps api[\s\S]*exit 1[\s\S]*fi/,
    );
    assert.match(section, /"\$\{compose\[@\]\}" up -d --no-deps api/);
    assert.doesNotMatch(section, /docker ps --filter label=com\.docker\.compose\.service=api/);
    assert.match(section, /integrations\/vip\/preflight/);
    assert.match(section, /\[ "\$\{code\}" = "401" \]/);
    assert.match(section, /integrations\/vip\/lifecycle/);
    assert.match(section, /revision_required/);
    assert.match(section, /player_not_found/);
    assert.match(section, /\|\| return 1/);
    assert.match(section, /rm -f "\$\{probe_response\}"/);
    assert.match(section, /bss-vip-lifecycle-v1/);

    const validation = section.indexOf(`\${#BSS_SSO_SHARED_SECRET} < 32`);
    const encoding = section.indexOf('encoded_secret="$(');
    const previousModeRead = section.indexOf('previous_revision_mode="$(');
    const productionMatch = section.indexOf('BSS_SSO_ENV_VERIFY_ONLY=true');
    const ownershipAudit = section.indexOf('dist/tools/audit-vip-lifecycle-ownership.js');
    const mutation = section.indexOf(`change_revision_mode "\${VIP_REVISION_MODE}"`);
    assert.ok(validation >= 0 && encoding > validation && previousModeRead > validation);
    assert.ok(
      productionMatch > validation && ownershipAudit > productionMatch && mutation > ownershipAudit,
    );
    assert.match(section, /\$\{#BSS_SSO_SHARED_SECRET\} > 512/);
    assert.match(section, /BSS_SSO_SHARED_SECRET.*\[:space:\]/);

    const changeMode = section.slice(section.indexOf('change_revision_mode()'));
    const environmentMutation = changeMode.indexOf('VIP_LIFECYCLE_REQUIRE_REVISION_DESIRED');
    const stopBeforeDisable = changeMode.indexOf(`"\${compose[@]}" stop api`);
    const explicitDisable = changeMode.indexOf('VIP_LIFECYCLE_FENCE_ACTION=disable');
    const rollbackEnvironment = changeMode.indexOf('VIP_LIFECYCLE_REQUIRE_REVISION_DESIRED=true');
    const apiRestart = changeMode.indexOf(`"\${compose[@]}" up -d --no-deps api`);
    assert.ok(
      environmentMutation >= 0 &&
        stopBeforeDisable > environmentMutation &&
        explicitDisable > stopBeforeDisable &&
        rollbackEnvironment > explicitDisable &&
        apiRestart > rollbackEnvironment,
    );
  });

  it('provisions the site read token only for the exact dev SHA without restarting services', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const start = workflow.indexOf('provision-site-read-token:');
    const end = workflow.indexOf('revoke-sessions-for-sso-cutover:');
    const provision = workflow.slice(start, end);
    const ci = readFileSync(path.join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8');

    assert.ok(start >= 0 && end > start);
    assert.match(provision, /name: Verify exact dev revision/);
    assert.match(provision, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/);
    assert.match(provision, /GITHUB_REF.*refs\/heads\/dev/);
    assert.match(provision, /EXPECTED_SHA.*GITHUB_SHA/);
    assert.match(provision, /secrets\.PANEL_READ_API_TOKEN/);
    assert.match(provision, /base64 -w 0/);
    assert.match(provision, /SITE_PANEL_READ_TOKEN_B64/);
    assert.doesNotMatch(provision, /base64 --decode/);
    assert.match(provision, /scripts\/provision-site-read-token\.mjs/);
    assert.match(provision, /node --input-type=module/);
    assert.doesNotMatch(provision, /restart|\bstop\b|\bup -d\b|deploy-tk104\.sh/i);
    assert.match(ci, /CI_IMAGE_TAG: ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(
      ci,
      /docker run --rm --entrypoint node "squad-admin-panel\/api:\$\{CI_IMAGE_TAG\}" --input-type=module -e "await import\('postgres'\)"/,
    );
  });

  it('atomically configures SSO and an isolated VIP secret without printing either secret', () => {
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
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(VIP_SECRET));
    assert.equal(
      readFileSync(envFile, 'utf8'),
      "POSTGRES_PASSWORD='keep-byte-for-byte'\n" +
        'BSS_SSO_CLIENT_ID=squad-admin-panel\n' +
        'UNKNOWN=keep\n' +
        'BSS_SITE_URL=https://bss.games\n' +
        `BSS_SSO_CLIENT_SECRET=${SECRET}\n` +
        'BSS_SSO_CLIENT_SECRET_NEXT=\n' +
        `VIP_LIFECYCLE_WEBHOOK_SECRET=${VIP_SECRET}\n` +
        'VIP_LIFECYCLE_REQUIRE_REVISION=false\n',
    );
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
  });

  it('preserves strict revision mode on ordinary deploy and changes it only explicitly', () => {
    const root = temporaryRoot();
    const envFile = path.join(root, '.env.tk104');
    writeFileSync(envFile, 'VIP_LIFECYCLE_REQUIRE_REVISION=true\n', { mode: 0o600 });

    const preserved = run(root, SECRET);
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.match(readFileSync(envFile, 'utf8'), /VIP_LIFECYCLE_REQUIRE_REVISION=true\n/);

    const relaxed = run(root, SECRET, { VIP_LIFECYCLE_REQUIRE_REVISION_DESIRED: 'false' });
    assert.equal(relaxed.status, 0, relaxed.stderr);
    assert.match(readFileSync(envFile, 'utf8'), /VIP_LIFECYCLE_REQUIRE_REVISION=false\n/);

    const invalid = run(root, SECRET, { VIP_LIFECYCLE_REQUIRE_REVISION_DESIRED: 'yes' });
    assert.notEqual(invalid.status, 0);
    assert.match(readFileSync(envFile, 'utf8'), /VIP_LIFECYCLE_REQUIRE_REVISION=false\n/);
  });

  it('sets only an explicit canonical panel release SHA and rejects malformed input', () => {
    const root = temporaryRoot();
    const envFile = path.join(root, '.env.tk104');
    writeFileSync(envFile, 'APP_VERSION=previous\nUNKNOWN=keep\n', { mode: 0o600 });

    const sha = 'a'.repeat(40);
    const updated = run(root, SECRET, { PANEL_RELEASE_SHA_DESIRED: sha });
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(
      readFileSync(envFile, 'utf8'),
      `APP_VERSION=${sha}\nUNKNOWN=keep\n${expectedManaged()}`,
    );

    const beforeInvalid = readFileSync(envFile, 'utf8');
    const invalid = run(root, SECRET, { PANEL_RELEASE_SHA_DESIRED: 'main' });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(envFile, 'utf8'), beforeInvalid);
  });

  it('accepts the exact SHA-newline-secret stream used by a full deploy', () => {
    const root = temporaryRoot();
    const envFile = path.join(root, '.env.tk104');
    writeFileSync(envFile, 'APP_VERSION=previous\n', { mode: 0o600 });
    const sha = 'b'.repeat(40);

    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        `set -euo pipefail; IFS= read -r panel_release_sha; PANEL_RELEASE_SHA_DESIRED="\${panel_release_sha}" APP_DIR="$1" bash "$2"`,
        'full-deploy-stream',
        root,
        SCRIPT,
      ],
      {
        env: process.env,
        input: `${sha}\n${SECRET}`,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(envFile, 'utf8'), new RegExp(`^APP_VERSION=${sha}$`, 'm'));
  });

  it('checks every managed value without writing, restarting, or exposing secrets', () => {
    const sha = 'c'.repeat(40);
    const canonical = `APP_VERSION=${sha}\n${expectedManaged()}`;
    const mismatches = [
      canonical.replace('BSS_SITE_URL=https://bss.games', 'BSS_SITE_URL=https://other.invalid'),
      canonical.replace('BSS_SSO_CLIENT_ID=squad-admin-panel', 'BSS_SSO_CLIENT_ID=other'),
      canonical.replace(`BSS_SSO_CLIENT_SECRET=${SECRET}`, 'BSS_SSO_CLIENT_SECRET=other-secret'),
      canonical.replace('BSS_SSO_CLIENT_SECRET_NEXT=', 'BSS_SSO_CLIENT_SECRET_NEXT=pending'),
      canonical.replace(
        `VIP_LIFECYCLE_WEBHOOK_SECRET=${VIP_SECRET}`,
        `VIP_LIFECYCLE_WEBHOOK_SECRET=${'0'.repeat(64)}`,
      ),
      canonical.replace(`APP_VERSION=${sha}`, `APP_VERSION=${'d'.repeat(40)}`),
    ];

    for (const source of [canonical, ...mismatches]) {
      const root = temporaryRoot();
      const envFile = path.join(root, '.env.tk104');
      writeFileSync(envFile, source, { mode: 0o600 });

      const result = run(root, SECRET, {
        BSS_SSO_ENV_VERIFY_ONLY: 'true',
        PANEL_RELEASE_SHA_DESIRED: sha,
      });

      assert.equal(result.status === 0, source === canonical, result.stderr);
      assert.equal(readFileSync(envFile, 'utf8'), source);
      const output = `${result.stdout}${result.stderr}`;
      assert.ok(!output.includes(SECRET));
      assert.ok(!output.includes(VIP_SECRET));
    }

    const unicodeSecret = 'секрет'.repeat(8);
    const unicodeVipSecret = createHmac('sha256', unicodeSecret)
      .update('bss-vip-lifecycle-v1')
      .digest('hex');
    const unicodeRoot = temporaryRoot();
    const unicodeEnvFile = path.join(unicodeRoot, '.env.tk104');
    const unicodeSource = canonical
      .replace(`BSS_SSO_CLIENT_SECRET=${SECRET}`, `BSS_SSO_CLIENT_SECRET=${unicodeSecret}`)
      .replace(
        `VIP_LIFECYCLE_WEBHOOK_SECRET=${VIP_SECRET}`,
        `VIP_LIFECYCLE_WEBHOOK_SECRET=${unicodeVipSecret}`,
      );
    writeFileSync(unicodeEnvFile, unicodeSource, { mode: 0o600 });
    const unicodeResult = run(unicodeRoot, unicodeSecret, {
      BSS_SSO_ENV_VERIFY_ONLY: 'true',
      PANEL_RELEASE_SHA_DESIRED: sha,
    });
    assert.equal(unicodeResult.status, 0, unicodeResult.stderr);
    assert.equal(readFileSync(unicodeEnvFile, 'utf8'), unicodeSource);
    assert.ok(!`${unicodeResult.stdout}${unicodeResult.stderr}`.includes(unicodeSecret));

    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
      'utf8',
    );
    const section = workflow.slice(workflow.indexOf('configure-vip-revision-mode:'));
    assert.ok(
      section.indexOf('BSS_SSO_ENV_VERIFY_ONLY=true') <
        section.indexOf(`change_revision_mode "\${VIP_REVISION_MODE}"`),
    );
    assert.match(section, /BSS SSO\/VIP settings do not match production; refusing cutover/);

    const script = readFileSync(SCRIPT, 'utf8');
    assert.match(script, /hmac\.compare_digest/);
  });

  it('refuses an unsafe or non-exact secret stream without changing the file', () => {
    for (const input of [
      'short',
      `${SECRET}\n`,
      `${SECRET}\ntrailing-data`,
      `${SECRET}\tunsafe`,
      'x'.repeat(513),
    ]) {
      const root = temporaryRoot();
      const envFile = path.join(root, '.env.tk104');
      const original = 'POSTGRES_PASSWORD=keep\n';
      writeFileSync(envFile, original, { mode: 0o640 });

      const result = run(root, input);

      assert.notEqual(result.status, 0, `unexpectedly accepted ${JSON.stringify(input)}`);
      assert.equal(readFileSync(envFile, 'utf8'), original);
      assert.equal(statSync(envFile).mode & 0o777, 0o640);
    }
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
