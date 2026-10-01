import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  copyScript,
  executable,
  loggingShim,
  logLines,
  runAsync,
  shimDirectory,
} from './test-helpers/ops.ts';
import { imageRef, RELEASE_SHA } from './test-helpers/stand-release.ts';

describe('the stand host forced-command deploy entry', { concurrency: true }, () => {
  const VALID = [
    'deploy',
    RELEASE_SHA,
    `api=sha256:${'1'.repeat(64)}`,
    `web=sha256:${'2'.repeat(64)}`,
    `workers=sha256:${'3'.repeat(64)}`,
    `caddy=sha256:${'4'.repeat(64)}`,
  ].join(' ');

  function entryFixture(): {
    root: string;
    script: string;
    log: string;
    src: string;
    app: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/deploy-entry.sh');
    const src = path.join(root, 'src');
    const app = path.join(root, 'app');
    // rsync is a shim, so the synced tree is prepared by hand; its deploy
    // script is a stand-in recording what the entry handed over.
    mkdirSync(path.join(app, 'scripts'), { recursive: true });
    executable(
      path.join(app, 'scripts/deploy-stand.sh'),
      `printf 'deploy|%s|%s|%s|%s|%s|%s|%s\\n' "$PWD" "$APP_DIR" "$RELEASE_SHA" "$API_IMAGE" "$WEB_IMAGE" "$WORKERS_IMAGE" "$CADDY_IMAGE" >> "\${OPS_LOG:?}"`,
    );
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    loggingShim(
      shims,
      'git',
      [
        `if [[ -n "\${FAIL_GIT_MATCH:-}" && "$*" == *"$FAIL_GIT_MATCH"* ]]; then exit 128; fi`,
        `if [[ "$*" == *'rev-parse HEAD' ]]; then printf '%s\\n' "\${GIT_HEAD:-}"; fi`,
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'rsync');
    return {
      root,
      script,
      log,
      src,
      app,
      env: {
        OPS_LOG: log,
        PANEL_SRC_DIR: src,
        PANEL_APP_DIR: app,
        PATH: `${shims}:/usr/bin:/bin`,
        GIT_HEAD: RELEASE_SHA,
        // The runner's own session must not leak a request into the test.
        SSH_ORIGINAL_COMMAND: undefined,
      },
    };
  }

  it('refuses anything but the exact deploy request, before git, rsync or the deploy', async () => {
    const fixture = entryFixture();
    const sentinel = path.join(fixture.root, 'pwned');
    const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
    const requests = [
      '',
      'deploy',
      `${VALID}; rm -rf ~`,
      `${VALID} && touch ${sentinel}`,
      `${VALID} extra`,
      `${VALID}\ntouch ${sentinel}`,
      `${VALID}\n`,
      ` ${VALID}`,
      VALID.replace(' api=', '  api='),
      VALID.replace(' api=', '\tapi='),
      VALID.replace(RELEASE_SHA, RELEASE_SHA.slice(1)),
      VALID.replace(RELEASE_SHA, `${RELEASE_SHA}0`),
      VALID.replace(RELEASE_SHA, RELEASE_SHA.toUpperCase()),
      VALID.replace(RELEASE_SHA, `$(touch ${sentinel})`),
      VALID.replace(digest('2'), digest('2').toUpperCase()),
      VALID.replace(digest('2'), '2'.repeat(64)),
      VALID.replace(digest('3'), `sha256:${'3'.repeat(63)}`),
      VALID.replace(`web=${digest('2')} workers=`, `workers=${digest('2')} web=`),
      VALID.replace('caddy=', 'caddy-stand='),
      VALID.replace('deploy ', 'rollback '),
    ];
    for (const request of requests) {
      const result = await runAsync('/bin/bash', [fixture.script], {
        env: { ...fixture.env, SSH_ORIGINAL_COMMAND: request },
      });
      assert.equal(result.status, 2, JSON.stringify(request));
      assert.match(result.stderr, /^refused: expected 'deploy <40-hex sha> api=sha256:/);
      assert.deepEqual(logLines(fixture.log), [], JSON.stringify(request));
    }
    const bare = await runAsync('/bin/bash', [fixture.script], { env: fixture.env });
    assert.equal(bare.status, 2);
    // A forced command's request always wins over arguments.
    const smuggled = await runAsync('/bin/bash', [fixture.script, ...VALID.split(' ')], {
      env: { ...fixture.env, SSH_ORIGINAL_COMMAND: 'rollback' },
    });
    assert.equal(smuggled.status, 2);
    assert.deepEqual(logLines(fixture.log), []);
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(fixture.src), false);
  });

  it('fetches the commit, syncs it without host state, and hands over to its deploy script', async () => {
    const fixture = entryFixture();
    const result = await runAsync('/bin/bash', [fixture.script], {
      env: { ...fixture.env, SSH_ORIGINAL_COMMAND: VALID },
    });
    assert.equal(result.status, 0, result.stderr);
    const excludes = [
      '.git',
      'node_modules',
      '.next',
      'data',
      'dist',
      '.env',
      '.env.*',
      '.release*',
    ]
      .map((pattern) => `--exclude|${pattern}`)
      .join('|');
    assert.deepEqual(logLines(fixture.log), [
      `git|init|--quiet|${fixture.src}`,
      `git|-C|${fixture.src}|fetch|--quiet|--depth=1|--no-tags|https://github.com/seregatipich/squad-admin-panel.git|${RELEASE_SHA}`,
      `git|-C|${fixture.src}|-c|advice.detachedHead=false|checkout|--quiet|--force|--detach|${RELEASE_SHA}`,
      `git|-C|${fixture.src}|clean|--quiet|-ffdx`,
      `git|-C|${fixture.src}|rev-parse|HEAD`,
      `rsync|-a|--delete|${excludes}|${fixture.src}/|${fixture.app}/`,
      [
        'deploy',
        fixture.app,
        fixture.app,
        RELEASE_SHA,
        imageRef('api', '1'),
        imageRef('web', '2'),
        imageRef('workers', '3'),
        imageRef('caddy', '4'),
      ].join('|'),
    ]);
    // No installed copy exists in the fixture's checkout, so it says to reinstall.
    assert.match(result.stderr, /differs from scripts\/deploy-entry\.sh .* reinstall it/);
  });

  it('takes the same request as arguments when run by hand, with overridable locations', async () => {
    const fixture = entryFixture();
    mkdirSync(path.join(fixture.src, '.git'), { recursive: true });
    mkdirSync(path.join(fixture.src, 'scripts'), { recursive: true });
    copyFileSync(fixture.script, path.join(fixture.src, 'scripts/deploy-entry.sh'));
    const result = await runAsync('/bin/bash', [fixture.script, ...VALID.split(' ')], {
      env: {
        ...fixture.env,
        PANEL_REPO_URL: 'https://example.invalid/fork.git',
        PANEL_IMAGE_REPO: 'ghcr.io/example/panel',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = logLines(fixture.log);
    // The checkout already exists, so it is reused rather than initialised.
    assert.equal(
      commands.some((line) => line.startsWith('git|init|')),
      false,
    );
    assert.ok(commands.some((line) => line.includes('|https://example.invalid/fork.git|')));
    assert.ok(commands.at(-1)?.includes(`|ghcr.io/example/panel-api@sha256:${'1'.repeat(64)}|`));
    assert.doesNotMatch(result.stderr, /reinstall/);
  });

  it('stops before syncing when the commit cannot be fetched or checked out', async () => {
    const unfetchable = entryFixture();
    const fetchFailure = await runAsync('/bin/bash', [unfetchable.script], {
      env: { ...unfetchable.env, SSH_ORIGINAL_COMMAND: VALID, FAIL_GIT_MATCH: 'fetch' },
    });
    assert.equal(fetchFailure.status, 128);
    assert.equal(
      logLines(unfetchable.log).some(
        (line) => line.startsWith('rsync|') || line.startsWith('deploy|'),
      ),
      false,
    );

    const elsewhere = entryFixture();
    const wrongHead = await runAsync('/bin/bash', [elsewhere.script], {
      env: { ...elsewhere.env, SSH_ORIGINAL_COMMAND: VALID, GIT_HEAD: 'b'.repeat(40) },
    });
    assert.equal(wrongHead.status, 1);
    assert.match(wrongHead.stderr, /is at 'b{40}', expected a{40}/);
    assert.equal(
      logLines(elsewhere.log).some(
        (line) => line.startsWith('rsync|') || line.startsWith('deploy|'),
      ),
      false,
    );
  });
});
