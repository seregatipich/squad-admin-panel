import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { executable, logLines, REPOSITORY_ROOT, run, temporaryRoot } from './test-helpers/ops.ts';

/**
 * Regression cover for #291: `scripts/test-backup-restore.sh`'s `wait_pg`
 * returned as soon as a single socket-based `pg_isready` succeeded, which the
 * postgres image's TEMPORARY init server satisfies. The socket then vanishes
 * during the handover to the real server and the seeding psql fails with
 * "No such file or directory".
 *
 * `wait_pg` is extracted from the real script (so the test cannot drift from
 * it) and exercised against a stub `docker` that reproduces the two-phase
 * startup: a socket-only temporary server first, the real server after.
 */
function waitPgHarness(phases: string): { script: string; log: string; env: NodeJS.ProcessEnv } {
  const source = readFileSync(path.join(REPOSITORY_ROOT, 'scripts/test-backup-restore.sh'), 'utf8');
  const readyVars = source.match(/^PG_READY_ATTEMPTS=.*\nPG_READY_STREAK=.*$/m)?.[0] ?? '';
  const waitPg = source.match(/^wait_pg\(\) \{[\s\S]*?^\}$/m)?.[0];
  assert.ok(waitPg, 'could not extract wait_pg() from scripts/test-backup-restore.sh');

  const root = temporaryRoot('wait-pg');
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, 'ops.log');
  writeFileSync(log, '');

  // Stub docker: `phases` decides, per invocation, whether the TCP probe
  // succeeds. Every invocation is logged so the test can count probes.
  executable(
    path.join(bin, 'docker'),
    [
      'printf "docker" >> "${OPS_LOG:?}"',
      'for argument in "$@"; do printf "|%s" "$argument" >> "${OPS_LOG:?}"; done',
      'printf "\\n" >> "${OPS_LOG:?}"',
      'count=$(grep -c . "${OPS_LOG:?}")',
      phases,
    ].join('\n'),
  );
  // Keep the test fast: the real script sleeps 1s per attempt.
  executable(path.join(bin, 'sleep'), 'exit 0');

  const script = path.join(root, 'harness.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'fail() { echo "FAIL: $*" >&2; exit 9; }',
      readyVars,
      waitPg,
      'wait_pg pg-source && echo "PG-READY"',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { script, log, env: { OPS_LOG: log, PATH: `${bin}:${process.env.PATH ?? ''}` } };
}

describe('backup-restore postgres readiness (#291)', () => {
  it('does not accept the socket-only temporary init server as ready', () => {
    // The temporary server answers for the first 5 probes, then the real
    // server takes over. A single-sample wait would return during that window.
    const fixture = waitPgHarness('if [ "$count" -le 5 ]; then exit 2; fi\nexit 0');
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PG-READY/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('docker|'));
    assert.ok(
      probes.length > 5,
      `expected wait_pg to keep probing past the temporary server, got ${probes.length}`,
    );
    // Every probe must go over TCP — the discriminator the temporary server
    // (started with listen_addresses='') can never satisfy.
    for (const probe of probes) {
      assert.match(probe, /\|-h\|127\.0\.0\.1\|/, `probe did not use TCP: ${probe}`);
    }
  });

  it('requires consecutive successes, so a momentary window is not enough', () => {
    // Succeed once, then fail again: a streak-of-1 implementation would return.
    const fixture = waitPgHarness(
      'if [ "$count" -eq 2 ] || [ "$count" -ge 12 ]; then exit 0; fi\nexit 2',
    );
    const result = run('/bin/bash', [fixture.script], { env: fixture.env });

    assert.equal(result.status, 0, result.stderr);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('docker|'));
    assert.ok(
      probes.length >= 12,
      `a single lucky probe must not satisfy wait_pg, got ${probes.length}`,
    );
  });

  it('fails closed when postgres never becomes ready', () => {
    const fixture = waitPgHarness('exit 2');
    const result = run('/bin/bash', [fixture.script], {
      env: { ...fixture.env, PG_READY_ATTEMPTS: '7' },
    });

    assert.equal(result.status, 9);
    assert.match(result.stderr, /never became stably ready over TCP/);
    assert.doesNotMatch(result.stdout, /PG-READY/);
    assert.equal(
      logLines(fixture.log).filter((line) => line.startsWith('docker|')).length,
      7,
      'expected the attempt budget to be honoured',
    );
  });
});
