import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const workflow = readFileSync(
  path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
  'utf8',
);

function job(name: string, next?: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = next ? workflow.indexOf(`  ${next}:\n`) : workflow.length;
  assert.ok(start >= 0 && end > start, `job ${name} is missing`);
  return workflow.slice(start, end);
}

const fullDeploy = job('deploy', 'deploy-web-preview');
const webPreview = job('deploy-web-preview');

describe('deploy-tk104 workflow', () => {
  it('fails a manual full deploy before checkout unless it targets the exact master SHA', () => {
    const guard = fullDeploy.indexOf('name: Verify exact master revision');
    const checkout = fullDeploy.indexOf('uses: actions/checkout');

    assert.ok(guard >= 0 && checkout > guard);
    assert.match(fullDeploy, /GITHUB_REF.*refs\/heads\/master/);
    assert.match(fullDeploy, /GITHUB_EVENT_NAME.*workflow_dispatch/);
    assert.match(fullDeploy, /PANEL_EXPECTED_SHA.*GITHUB_SHA/);
    assert.match(fullDeploy, /PANEL_EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/);
  });

  it('pins tk104 SSH trust in every deploy job', () => {
    assert.doesNotMatch(workflow, /ssh-keyscan|StrictHostKeyChecking=accept-new/);
    for (const [section, connections] of [
      [fullDeploy, 3],
      [webPreview, 3],
    ] as const) {
      assert.match(section, /TK104_SSH_KNOWN_HOSTS: \$\{\{ secrets\.TK104_SSH_KNOWN_HOSTS \}\}/);
      assert.match(section, /if \[\[ -z "\$\{TK104_SSH_KNOWN_HOSTS\}" \]\]; then/);
      assert.match(section, /ssh-keygen -l -f/);
      assert.match(section, /ssh-keygen -F tk104\.duckdns\.org -f/);
      assert.match(section, /chmod 600 "\$\{RUNNER_TEMP\}\/tk104_known_hosts"/);
      assert.equal((section.match(/StrictHostKeyChecking=yes/g) ?? []).length, connections);
      assert.equal((section.match(/UserKnownHostsFile=/g) ?? []).length, connections);
      assert.match(
        section,
        /rm -rf ~\/\.ssh\/id_deploy "\$\{RUNNER_TEMP\}\/tk104_known_hosts" "\$\{RUNNER_TEMP\}\/release-images"/,
      );
    }
  });

  it('stamps the full deploy with the exact release SHA and waits for it on /health', () => {
    const start = fullDeploy.indexOf('name: Start the release on tk104');
    const health = fullDeploy.indexOf('name: External health check');

    assert.ok(start >= 0 && health > start);
    assert.match(
      fullDeploy.slice(start, health),
      /export APP_VERSION='\$\{GITHUB_SHA\}' PANEL_IMAGE_TAG='\$\{GITHUB_SHA\}'; bash scripts\/deploy-tk104\.sh/,
    );
    assert.match(fullDeploy.slice(health), /\.version == \$revision/);
  });

  it('deploys only images from a green dev ci run of the same commit, loaded before the start', () => {
    for (const [section, start] of [
      [fullDeploy, 'name: Start the release on tk104'],
      [webPreview, 'name: Restart only web on tk104'],
    ] as const) {
      const find = section.indexOf('name: Find the green dev CI run');
      const download = section.indexOf('name: Download the release images');
      const load = section.indexOf('name: Load the release images on tk104');
      const sync = section.indexOf('name: Sync repository to tk104');
      const restart = section.indexOf(start);
      assert.ok(find >= 0 && download > find && load > download && sync > load && restart > sync);
      assert.match(
        section,
        /actions\/workflows\/ci\.yml\/runs\?branch=dev&head_sha=\$\{RELEASE_SHA\}&status=success/,
      );
      assert.match(section, /has no successful ci run on dev; refusing to deploy it/);
      assert.match(section, /\^\[0-9a-f\]\{40\}\$/);
      assert.match(section, /name: release-images-\$\{\{ steps\.release\.outputs\.sha \}\}/);
      assert.match(section, /run-id: \$\{\{ steps\.release\.outputs\.run_id \}\}/);
      assert.match(
        section,
        /zstd -dc "\$\{RUNNER_TEMP\}\/release-images\/release-images\.tar\.zst"/,
      );
      assert.match(section, /seregatipich@tk104\.duckdns\.org 'docker load'/);
      assert.match(section, /--exclude '\.release' --exclude '\.release\.prev'/);
    }
    assert.match(
      webPreview,
      /RELEASE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.expected_sha \}\}/,
    );
    assert.match(
      webPreview,
      /export PANEL_IMAGE_TAG='\$\{RELEASE_SHA\}'; bash scripts\/deploy-tk104-web\.sh/,
    );
  });

  it('never builds on the production host', () => {
    assert.doesNotMatch(workflow, /docker compose[^\n]*build|DEPLOY_BUILD|docker build/);
  });

  it('offers only the full deploy and the web preview as manual targets', () => {
    assert.match(workflow, /options: \[full, web\]/);
    assert.deepEqual(
      [...workflow.matchAll(/^ {2}([a-z0-9-]+):\n/gmu)].map((match) => match[1]),
      ['push', 'deploy', 'deploy-web-preview'],
    );
    assert.doesNotMatch(workflow, /bss|BSS_|sso|VIP_LIFECYCLE|site_expected_sha|vip_revision/iu);
  });
});
