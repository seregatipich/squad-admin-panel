import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  executable,
  REPOSITORY_ROOT,
  run,
  shimDirectory,
  temporaryRoot,
} from './test-helpers/ops.ts';

/**
 * `scripts/test-fullstack-down-v.sh` destroys the postgres/redis bind trees to
 * make the data loss real before restoring. It used to `rm -rf dir/* 2>/dev/null
 * || true`: a permission error, a mis-parsed quoted DATA_DIR or dot files left
 * the data in place and the run still printed PASS without a restore ever
 * being exercised. The helpers are extracted from the real script so the test
 * cannot drift from it.
 */
function fullstackHelpers(): string {
  const source = readFileSync(
    path.join(REPOSITORY_ROOT, 'scripts/test-fullstack-down-v.sh'),
    'utf8',
  );
  const helpers = ['resolve_data_dir', 'wipe_bind_dir'].map((name) => {
    const body = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm'))?.[0];
    assert.ok(body, `could not extract ${name}() from scripts/test-fullstack-down-v.sh`);
    return body;
  });
  return helpers.join('\n');
}

function fullstackHarness(root: string, body: string): string {
  const script = path.join(root, 'harness.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -Eeuo pipefail',
      'fail() { echo "FAIL: $*" >&2; exit 9; }',
      fullstackHelpers(),
      body,
    ].join('\n'),
    { mode: 0o755 },
  );
  return script;
}

describe('full-stack down -v data wipe', () => {
  it('removes regular and dot files and leaves the bind empty', () => {
    const root = temporaryRoot('fullstack-wipe');
    const bind = path.join(root, 'postgres');
    mkdirSync(path.join(bind, 'base'), { recursive: true });
    writeFileSync(path.join(bind, 'PG_VERSION'), '16');
    writeFileSync(path.join(bind, '.s.PGSQL.lock'), 'lock');
    writeFileSync(path.join(bind, 'base/1'), 'rows');
    const result = run('/bin/bash', [fullstackHarness(root, `wipe_bind_dir "${bind}"`)]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(bind), []);
  });

  it('fails when the bind directory does not exist', () => {
    const root = temporaryRoot('fullstack-wipe-missing');
    const result = run('/bin/bash', [
      fullstackHarness(root, `wipe_bind_dir "${path.join(root, 'absent')}"`),
    ]);
    assert.equal(result.status, 9);
    assert.match(result.stderr, /does not exist/);
  });

  it(
    'fails instead of passing when a file cannot be removed',
    { skip: process.getuid?.() === 0 ? 'root can delete anything' : false },
    () => {
      const root = temporaryRoot('fullstack-wipe-denied');
      const bind = path.join(root, 'redis');
      mkdirSync(path.join(bind, 'locked'), { recursive: true });
      writeFileSync(path.join(bind, 'locked/dump.rdb'), 'data');
      chmodSync(path.join(bind, 'locked'), 0o500);
      try {
        const result = run('/bin/bash', [fullstackHarness(root, `wipe_bind_dir "${bind}"`)]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /could not wipe/);
      } finally {
        chmodSync(path.join(bind, 'locked'), 0o700);
      }
    },
  );

  it('fails when the bind is still not empty after the wipe', () => {
    const root = temporaryRoot('fullstack-wipe-noop');
    const bind = path.join(root, 'postgres');
    mkdirSync(bind, { recursive: true });
    writeFileSync(path.join(bind, 'PG_VERSION'), '16');
    const shims = shimDirectory();
    executable(path.join(shims, 'find'), 'exit 0');
    const result = run('/bin/bash', [fullstackHarness(root, `wipe_bind_dir "${bind}"`)], {
      env: { PATH: `${shims}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 9);
    assert.match(result.stderr, /still not empty/);
  });

  it('strips quotes from DATA_DIR and resolves it against the repository', () => {
    const root = temporaryRoot('fullstack-data-dir');
    const cases: Array<[string, string]> = [
      ['DATA_DIR="./data"\n', path.join(root, 'data')],
      ["DATA_DIR='/srv/panel data'\n", '/srv/panel data'],
      ['OTHER=1\n', path.join(root, 'data')],
      ['DATA_DIR=./one\nDATA_DIR=/srv/two # host data\n', '/srv/two'],
    ];
    for (const [envFile, expected] of cases) {
      writeFileSync(path.join(root, '.env'), envFile);
      const result = run('/bin/bash', [
        fullstackHarness(root, `REPO="${root}"; resolve_data_dir "${path.join(root, '.env')}"`),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected, envFile);
    }
  });
});
