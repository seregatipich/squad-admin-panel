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
      [fullDeploy, 2],
      [webPreview, 2],
    ] as const) {
      assert.match(section, /TK104_SSH_KNOWN_HOSTS: \$\{\{ secrets\.TK104_SSH_KNOWN_HOSTS \}\}/);
      assert.match(section, /if \[\[ -z "\$\{TK104_SSH_KNOWN_HOSTS\}" \]\]; then/);
      assert.match(section, /ssh-keygen -l -f/);
      assert.match(section, /ssh-keygen -F tk104\.duckdns\.org -f/);
      assert.match(section, /chmod 600 "\$\{RUNNER_TEMP\}\/tk104_known_hosts"/);
      assert.equal((section.match(/StrictHostKeyChecking=yes/g) ?? []).length, connections);
      assert.equal((section.match(/UserKnownHostsFile=/g) ?? []).length, connections);
      assert.match(section, /rm -f ~\/\.ssh\/id_deploy "\$\{RUNNER_TEMP\}\/tk104_known_hosts"/);
    }
  });

  it('stamps the full deploy with the exact release SHA and waits for it on /health', () => {
    const build = fullDeploy.indexOf('name: Build and restart the stack on tk104');
    const health = fullDeploy.indexOf('name: External health check');

    assert.ok(build >= 0 && health > build);
    assert.match(
      fullDeploy.slice(build, health),
      /export APP_VERSION='\$\{GITHUB_SHA\}'; bash scripts\/deploy-tk104\.sh/,
    );
    assert.match(fullDeploy.slice(health), /\.version == \$revision/);
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
