import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const workflow = readFileSync(
  path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
  'utf8',
);
const IMAGES = ['api', 'web', 'workers', 'caddy-tk104'] as const;
const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567';
// A throwaway public key; only its shape matters to ssh-keygen.
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICkRPgVfqvX/r75lejiVRHnqb1XiL5DdeDRa19D9teZg';
const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} is missing`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/u);
  return next < 0 ? workflow.slice(start + 1) : workflow.slice(start + 1, start + 1 + next + 1);
}

function step(section: string, name: string): string {
  const start = section.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `step '${name}' is missing`);
  const rest = section.slice(start + 1);
  const next = rest.search(/\n {6}- /u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The `run: |` body of a step, dedented, exactly as the runner hands it to bash. */
function runScript(stepBlock: string): string {
  const lines = stepBlock.split('\n');
  const start = lines.indexOf('        run: |');
  assert.ok(start >= 0, 'step has no run block');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

interface StepRun {
  status: number | null;
  output: string;
  outputs: Record<string, string>;
  home: string;
  runnerTemp: string;
}

/**
 * Runs a step's script the way GitHub does (`bash -eo pipefail`), with the
 * given executables stubbed in front of PATH and a private HOME/RUNNER_TEMP.
 */
function runStep(
  script: string,
  env: Record<string, string>,
  stubs: Record<string, string>,
): StepRun {
  const root = mkdtempSync(path.join(tmpdir(), 'deploy-tk104-step-'));
  temporaryRoots.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const runnerTemp = path.join(root, 'runner-temp');
  for (const directory of [bin, home, runnerTemp]) mkdirSync(directory);
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  }
  const githubOutput = path.join(root, 'github-output');
  writeFileSync(githubOutput, '');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`,
      HOME: home,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_REPOSITORY: 'seregatipich/squad-admin-panel',
      STUB_LOG: path.join(root, 'stub.log'),
      ...env,
    },
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(githubOutput, 'utf8').split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    outputs,
    home,
    runnerTemp,
  };
}

function stubLog(run: StepRun): string[] {
  const log = path.join(path.dirname(run.home), 'stub.log');
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

const build = job('build');
const deploy = job('deploy');
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const DIGESTS: Record<(typeof IMAGES)[number], string> = {
  api: digest('a'),
  web: digest('b'),
  workers: digest('c'),
  'caddy-tk104': digest('d'),
};

describe('deploy-tk104 workflow triggers', () => {
  it('deploys every dev push except documentation-only ones, and on dispatch', () => {
    assert.match(
      workflow,
      /\non:\n {2}push:\n {4}branches: \[dev\]\n {4}paths-ignore:\n {6}- '\*\*\.md'\n {6}- 'docs\/\*\*'\n {2}workflow_dispatch:\n {4}inputs:\n {6}sha:\n/u,
    );
    assert.doesNotMatch(
      workflow,
      /refs\/heads\/master|workflow_run|pull_request|environment: production/u,
    );
  });

  it('has exactly a build and a deploy job and no workflow-level concurrency', () => {
    assert.deepEqual(
      [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z0-9-]+):\n/gmu)].map(
        (match) => match[1],
      ),
      ['build', 'deploy'],
    );
    assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\njobs:\n')), /^concurrency:/mu);
  });
});

describe('deploy-tk104 build job', () => {
  it('builds each release image in its own cancellable matrix leg on a hosted VM', () => {
    assert.match(build, /\n {4}runs-on: ubuntu-24\.04\n/u);
    assert.match(build, /\n {4}if: github\.repository == 'seregatipich\/squad-admin-panel'\n/u);
    assert.match(build, /\n {6}packages: write\n/u);
    assert.match(
      build,
      /\n {6}fail-fast: false\n {6}matrix:\n {8}image: \[api, web, workers, caddy-tk104\]\n/u,
    );
    assert.match(
      build,
      /\n {4}concurrency:\n {6}group: deploy-build-\$\{\{ matrix\.image \}\}\n {6}cancel-in-progress: true\n/u,
    );
  });

  it('validates the commit before the checkout and builds only a missing image', () => {
    const resolve = build.indexOf('name: Resolve the release commit');
    const checkout = build.indexOf('uses: actions/checkout@');
    const existing = build.indexOf('name: Check whether the image already exists');
    const bake = build.indexOf('name: Build and push the image');
    assert.ok(resolve >= 0 && checkout > resolve && existing > checkout && bake > existing);
    assert.match(build, /\n {10}ref: \$\{\{ steps\.release\.outputs\.sha \}\}\n/u);
    assert.match(
      step(build, 'Check whether the image already exists'),
      /IMAGE: ghcr\.io\/seregatipich\/squad-panel-\$\{\{ matrix\.image \}\}:\$\{\{ steps\.release\.outputs\.sha \}\}/u,
    );
    assert.match(
      step(build, 'Build and push the image'),
      /\n {8}if: steps\.existing\.outputs\.exists != 'true'\n/u,
    );
  });

  it('pushes the SHA and dev tags with a registry layer cache through docker-bake.hcl', () => {
    const bake = step(build, 'Build and push the image');
    assert.match(bake, /uses: docker\/bake-action@[0-9a-f]{40} # v/u);
    assert.match(bake, /\n {10}source: \.\n {10}files: docker-bake\.hcl\n/u);
    assert.match(bake, /\n {10}targets: \$\{\{ matrix\.image \}\}\n {10}push: true\n/u);
    const ref = 'ghcr.io/seregatipich/squad-panel-${{ matrix.image }}';
    for (const line of [
      `\${{ matrix.image }}.tags=${ref}:\${{ steps.release.outputs.sha }}`,
      `\${{ matrix.image }}.tags=${ref}:dev`,
      `\${{ matrix.image }}.cache-from=type=registry,ref=${ref}:buildcache`,
      `\${{ matrix.image }}.cache-to=type=registry,ref=${ref}:buildcache,mode=max`,
    ]) {
      assert.ok(bake.includes(`\n            ${line}\n`), `bake does not set ${line}`);
    }
  });

  describe('release commit resolution', () => {
    const script = runScript(step(build, 'Resolve the release commit'));
    // `gh api …/compare/<sha>...dev --jq .status` answers STUB_STATUS, or fails on "error".
    const gh = `printf '%s\\n' "$*" >> "$STUB_LOG"; [ "$STUB_STATUS" = error ] && exit 1; printf '%s\\n' "$STUB_STATUS"`;

    it('passes a pushed commit through without asking GitHub', () => {
      const run = runStep(script, { GITHUB_EVENT_NAME: 'push', RELEASE_SHA }, { gh: 'exit 99' });
      assert.equal(run.status, 0, run.output);
      assert.equal(run.outputs.sha, RELEASE_SHA);
    });

    for (const value of [
      '',
      'dev',
      RELEASE_SHA.slice(0, 12),
      `${RELEASE_SHA}\nsha=evil`,
      RELEASE_SHA.toUpperCase(),
    ]) {
      it(`rejects ${JSON.stringify(value)} as a release commit`, () => {
        const run = runStep(script, { GITHUB_EVENT_NAME: 'push', RELEASE_SHA: value }, {});
        assert.notEqual(run.status, 0);
        assert.equal(run.outputs.sha, undefined);
        assert.match(run.output, /full 40-character SHA/u);
      });
    }

    for (const status of ['ahead', 'identical']) {
      it(`deploys a dispatched commit that dev contains (compare status ${status})`, () => {
        const run = runStep(
          script,
          { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_SHA, STUB_STATUS: status },
          { gh },
        );
        assert.equal(run.status, 0, run.output);
        assert.equal(run.outputs.sha, RELEASE_SHA);
        assert.deepEqual(stubLog(run), [
          `api repos/seregatipich/squad-admin-panel/compare/${RELEASE_SHA}...dev --jq .status`,
        ]);
      });
    }

    for (const status of ['behind', 'diverged', 'error']) {
      it(`refuses a dispatched commit that is not on dev (${status})`, () => {
        const run = runStep(
          script,
          { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_SHA, STUB_STATUS: status },
          { gh },
        );
        assert.notEqual(run.status, 0);
        assert.equal(run.outputs.sha, undefined);
      });
    }
  });
});

describe('deploy-tk104 deploy job', () => {
  it('runs after every build, once at a time, in the tk104-dev environment', () => {
    assert.match(deploy, /\n {4}needs: build\n/u);
    assert.match(deploy, /\n {4}if: github\.repository == 'seregatipich\/squad-admin-panel'\n/u);
    assert.match(deploy, /\n {4}runs-on: ubuntu-24\.04\n/u);
    assert.match(
      deploy,
      /\n {4}environment:\n {6}name: tk104-dev\n {6}url: https:\/\/tk104\.duckdns\.org\n/u,
    );
    assert.match(
      deploy,
      /\n {4}concurrency:\n {6}group: deploy-tk104\n {6}cancel-in-progress: false\n/u,
    );
    assert.match(deploy, /\n {4}timeout-minutes: 15\n/u);
    assert.match(deploy, /\n {6}packages: read\n/u);
    assert.doesNotMatch(deploy, /packages: write/u);
  });

  it('never builds on or copies files to the host', () => {
    assert.doesNotMatch(
      deploy,
      // `docker buildx imagetools inspect` only reads the registry; building does not belong here.
      /docker build |docker buildx (build|bake)|docker compose|docker load|docker save|rsync|scp |bake-action|upload-artifact|download-artifact/u,
    );
  });

  it('pins tk104 SSH trust and removes the key whatever happens', () => {
    assert.doesNotMatch(workflow, /ssh-keyscan|StrictHostKeyChecking=(no|accept-new)/u);
    assert.equal((workflow.match(/StrictHostKeyChecking=yes/gu) ?? []).length, 1);
    assert.equal((workflow.match(/UserKnownHostsFile=/gu) ?? []).length, 1);
    const cleanup = step(deploy, 'Remove SSH deploy key');
    assert.match(cleanup, /\n {8}if: always\(\)\n/u);
    assert.match(cleanup, /rm -f ~\/\.ssh\/id_deploy "\$\{RUNNER_TEMP\}\/tk104_known_hosts"/u);
    const order = [
      'Resolve the release commit',
      'Resolve the image digests',
      'Configure pinned SSH trust and deploy key',
      'Deploy the release on tk104',
      'External health check',
      'Remove SSH deploy key',
    ].map((name) => deploy.indexOf(`      - name: ${name}\n`));
    assert.ok(order.every((index) => index >= 0));
    assert.deepEqual(
      order,
      [...order].sort((left, right) => left - right),
    );
  });

  describe('pinned SSH trust', () => {
    const script = runScript(step(deploy, 'Configure pinned SSH trust and deploy key'));
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----';

    it('writes the deploy key only for a valid tk104 host key', () => {
      const run = runStep(
        script,
        { TK104_SSH_KNOWN_HOSTS: `tk104.duckdns.org ${HOST_KEY}\n`, TK104_DEPLOY_KEY: key },
        {},
      );
      assert.equal(run.status, 0, run.output);
      const deployKey = path.join(run.home, '.ssh/id_deploy');
      assert.equal(readFileSync(deployKey, 'utf8'), `${key}\n`);
      assert.equal(statSync(deployKey).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(run.runnerTemp, 'tk104_known_hosts')).mode & 0o777, 0o600);
    });

    for (const [name, knownHosts, deployKey, message] of [
      ['a missing host key', '', key, /host key is missing/u],
      ['a malformed host key', 'tk104.duckdns.org not-a-key', key, /host key is invalid/u],
      ['a host key for another host', `example.org ${HOST_KEY}`, key, /host key is invalid/u],
      ['a missing deploy key', `tk104.duckdns.org ${HOST_KEY}`, '', /deploy key is missing/u],
    ] as const) {
      it(`refuses ${name}`, () => {
        const run = runStep(
          script,
          { TK104_SSH_KNOWN_HOSTS: knownHosts, TK104_DEPLOY_KEY: deployKey },
          {},
        );
        assert.notEqual(run.status, 0);
        assert.match(run.output, message);
        assert.throws(() => statSync(path.join(run.home, '.ssh/id_deploy')));
      });
    }
  });

  describe('image digests', () => {
    const script = runScript(step(deploy, 'Resolve the image digests'));
    // `docker buildx imagetools inspect <ref> --format …`: answers from DIGEST_<image>.
    const docker = [
      'printf "%s\\n" "$4" >> "$STUB_LOG"',
      'image=${4#ghcr.io/seregatipich/squad-panel-}',
      'image=${image%%:*}',
      'variable="DIGEST_${image//-/_}"',
      '[ -n "${!variable:-}" ] || exit 1',
      'printf \'{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s"}\\n\' "${!variable}"',
    ].join('\n');
    const digestEnv = (overrides: Record<string, string> = {}) => ({
      RELEASE_SHA,
      ...Object.fromEntries(
        IMAGES.map((image) => [`DIGEST_${image.replaceAll('-', '_')}`, DIGESTS[image]]),
      ),
      ...overrides,
    });

    it('resolves all four images of the release commit to digests, in contract order', () => {
      const run = runStep(script, digestEnv(), { docker });
      assert.equal(run.status, 0, run.output);
      assert.equal(
        run.outputs.images,
        IMAGES.map((image) => `${image}=${DIGESTS[image]}`).join(' '),
      );
      assert.deepEqual(
        stubLog(run),
        IMAGES.map((image) => `ghcr.io/seregatipich/squad-panel-${image}:${RELEASE_SHA}`),
      );
    });

    for (const [name, overrides] of [
      ['an image missing from GHCR', { DIGEST_workers: '' }],
      ['a truncated digest', { DIGEST_web: 'sha256:abc' }],
      ['a digest of another algorithm', { DIGEST_api: `sha512:${'a'.repeat(64)}` }],
      ['an injected digest', { DIGEST_caddy_tk104: `${digest('d')} rm` }],
    ] as const) {
      it(`fails on ${name}`, () => {
        const run = runStep(script, digestEnv(overrides), { docker });
        assert.notEqual(run.status, 0);
        assert.equal(run.outputs.images, undefined);
        assert.match(run.output, /has no valid digest/u);
      });
    }
  });

  it('sends tk104 exactly the forced-command contract over pinned SSH', () => {
    const images = IMAGES.map((image) => `${image}=${DIGESTS[image]}`).join(' ');
    const run = runStep(
      runScript(step(deploy, 'Deploy the release on tk104')),
      { RELEASE_SHA, RELEASE_IMAGES: images },
      { ssh: 'printf "%s\\n" "$@" >> "$STUB_LOG"' },
    );
    assert.equal(run.status, 0, run.output);
    const args = stubLog(run);
    const command = args.at(-1) ?? '';
    assert.equal(command, `deploy ${RELEASE_SHA} ${images}`);
    assert.match(
      command,
      /^deploy [0-9a-f]{40} api=sha256:[0-9a-f]{64} web=sha256:[0-9a-f]{64} workers=sha256:[0-9a-f]{64} caddy-tk104=sha256:[0-9a-f]{64}$/u,
    );
    assert.equal(args.at(-2), 'seregatipich@tk104.duckdns.org');
    const options = args.slice(0, -2).join(' ');
    assert.ok(options.includes(`-i ${run.home}/.ssh/id_deploy`), options);
    assert.ok(
      options.includes(`-o UserKnownHostsFile=${run.runnerTemp}/tk104_known_hosts`),
      options,
    );
    assert.ok(options.includes('-o StrictHostKeyChecking=yes'), options);
    assert.ok(options.includes('-o BatchMode=yes'), options);
  });

  describe('external health check', () => {
    const script = runScript(step(deploy, 'External health check'));
    // Serves the responses listed in CURL_RESPONSES ("<code>:<body>|…") in order,
    // repeating the last one; `sleep` only records how long it was asked to wait.
    const curl = [
      'count=$(($(wc -l < "$STUB_LOG" 2>/dev/null || echo 0) + 1))',
      'printf "%s\\n" "$*" >> "$STUB_LOG"',
      'IFS="|" read -r -a responses <<< "$CURL_RESPONSES"',
      'index=$((count <= ${#responses[@]} ? count - 1 : ${#responses[@]} - 1))',
      'response=${responses[$index]}',
      'while [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done',
      'printf "%s" "${response#*:}" > "$out"',
      'printf "%s" "${response%%:*}"',
      '[ "${response%%:*}" != 000 ]',
    ].join('\n');
    const sleep = 'printf "%s\\n" "$1" >> "$SLEEP_LOG"';

    function check(responses: string) {
      const root = mkdtempSync(path.join(tmpdir(), 'deploy-tk104-sleep-'));
      temporaryRoots.push(root);
      const sleepLog = path.join(root, 'sleep.log');
      writeFileSync(sleepLog, '');
      const run = runStep(
        script,
        { CURL_RESPONSES: responses, SLEEP_LOG: sleepLog },
        { curl, sleep },
      );
      return { run, sleeps: readFileSync(sleepLog, 'utf8').trim().split('\n').filter(Boolean) };
    }

    it('passes once /health answers 200 with status ok', () => {
      const { run, sleeps } = check(
        '000:|502:bad gateway|200:{"status":"starting"}|200:{"status":"ok"}',
      );
      assert.equal(run.status, 0, run.output);
      assert.equal(stubLog(run).length, 4);
      assert.deepEqual(sleeps, ['2', '2', '2']);
      assert.ok(stubLog(run).every((call) => call.includes('https://tk104.duckdns.org/health')));
    });

    it('gives up after about 90 s of polling every 2 s', () => {
      const { run, sleeps } = check('503:{"status":"ok"}');
      assert.notEqual(run.status, 0);
      assert.equal(stubLog(run).length, 45);
      assert.equal(sleeps.length, 45);
      assert.ok(sleeps.every((seconds) => seconds === '2'));
      assert.match(run.output, /did not report status ok within ~90 s \(last HTTP 503\)/u);
    });

    it('does not accept a 200 without status ok', () => {
      const { run } = check('200:{"status":"degraded"}');
      assert.notEqual(run.status, 0);
      assert.equal(stubLog(run).length, 45);
    });
  });
});
