import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  type CommandResult,
  copyScript,
  loggingShim,
  logLines,
  run,
  shimDirectory,
} from './test-helpers/ops.ts';

describe('new-test-db provisioning', () => {
  interface NewTestDbFixture {
    script: string;
    root: string;
    log: string;
    shims: string;
  }

  function newTestDbFixture(dotenv: string | null): NewTestDbFixture {
    const { root, script } = copyScript('scripts/new-test-db.sh');
    if (dotenv !== null) writeFileSync(path.join(root, '.env'), dotenv);
    const shims = shimDirectory();
    const log = path.join(root, 'ops.log');
    // `ps` lists NTD_CONTAINERS and the existence probe answers NTD_EXISTS, so each test
    // stages the docker host it needs without a real daemon.
    loggingShim(
      shims,
      'docker',
      [
        'case "$1" in',
        '  ps) for name in ${NTD_CONTAINERS:-}; do printf "%s\\n" "$name"; done ;;',
        '  exec) case "$*" in *-tAc*) [ "${NTD_EXISTS:-0}" = 1 ] && printf "1\\n" ;; esac ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    loggingShim(shims, 'pnpm', 'printf \'migrate-url|%s\\n\' "$DATABASE_URL" >> "$OPS_LOG"');
    return { script, root, log, shims };
  }

  function provision(
    fixture: NewTestDbFixture,
    args: string[],
    env: NodeJS.ProcessEnv = {},
  ): CommandResult {
    return run('/bin/bash', [fixture.script, ...args], {
      env: {
        PATH: `${fixture.shims}:/usr/bin:/bin`,
        OPS_LOG: fixture.log,
        NTD_CONTAINERS: 'squad-admin-panel-postgres-1',
        PG_CONTAINER: '',
        PG_HOST: '',
        PG_PORT: '',
        PG_USER: '',
        REDIS_HOST: '',
        REDIS_PORT: '',
        POSTGRES_PASSWORD: '',
        REDIS_PASSWORD: '',
        POSTGRES_HOST_PORT: '',
        REDIS_HOST_PORT: '',
        COMPOSE_PROJECT_NAME: '',
        ...env,
      },
    });
  }

  const DOTENV = 'POSTGRES_PASSWORD="pgsecret"\nREDIS_PASSWORD=redissecret\n';
  const TWO_STACKS = 'squad-admin-panel-postgres-1 other-wt-postgres-1';

  it('prints DATABASE_URL, TEST_DATABASE_URL and an isolated TEST_REDIS_URL on stdout only', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3']);

    assert.equal(result.status, 0, result.stderr);
    // cksum("test_wave3") % 8 == 3, so the slug lands on Redis logical database 11.
    assert.equal(
      result.stdout,
      [
        "export DATABASE_URL='postgres://admin:pgsecret@127.0.0.1:5432/test_wave3'",
        "export TEST_DATABASE_URL='postgres://admin:pgsecret@127.0.0.1:5432/test_wave3'",
        "export TEST_REDIS_URL='redis://:redissecret@127.0.0.1:6379/11'",
        '',
      ].join('\n'),
    );
    assert.match(result.stderr, /creating database test_wave3/);
    assert.ok(
      logLines(fixture.log).includes(
        'migrate-url|postgres://admin:pgsecret@127.0.0.1:5432/test_wave3',
      ),
    );
  });

  it('keeps the Redis logical database inside 8..15 and stable per slug', () => {
    const fixture = newTestDbFixture(DOTENV);
    for (const slug of ['a', 'prepush_worktree-one', 'x'.repeat(90), 'Mixed Case/Slug']) {
      const first = provision(fixture, [slug]);
      const second = provision(fixture, [slug]);
      assert.equal(first.status, 0, first.stderr);
      const database = Number(/TEST_REDIS_URL='[^']*\/(\d+)'/.exec(first.stdout)?.[1]);
      assert.ok(database >= 8 && database <= 15, `${slug}: ${database}`);
      assert.equal(first.stdout, second.stdout, slug);
    }
  });

  it('takes the Postgres and Redis host ports from .env, and PG_PORT/REDIS_PORT win over it', () => {
    const fixture = newTestDbFixture(`${DOTENV}POSTGRES_HOST_PORT=15432\nREDIS_HOST_PORT=16379\n`);
    const fromDotenv = provision(fixture, ['wave3']);
    assert.equal(fromDotenv.status, 0, fromDotenv.stderr);
    assert.match(fromDotenv.stdout, /@127\.0\.0\.1:15432\/test_wave3'/);
    assert.match(fromDotenv.stdout, /@127\.0\.0\.1:16379\/11'/);

    const explicit = provision(fixture, ['wave3'], { PG_PORT: '25432', REDIS_PORT: '26379' });
    assert.match(explicit.stdout, /@127\.0\.0\.1:25432\/test_wave3'/);
    assert.match(explicit.stdout, /@127\.0\.0\.1:26379\/11'/);
  });

  it('fails without a REDIS_PASSWORD instead of exporting a Redis URL that cannot authenticate', () => {
    const fixture = newTestDbFixture('POSTGRES_PASSWORD=pgsecret\n');
    const result = provision(fixture, ['wave3']);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /REDIS_PASSWORD is empty or missing in \.env/);
  });

  it('refuses to pick a container when several postgres containers run', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3'], { NTD_CONTAINERS: TWO_STACKS });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /several postgres containers are running/);
    assert.match(result.stderr, /squad-admin-panel-postgres-1/);
    assert.match(result.stderr, /other-wt-postgres-1/);
    assert.match(result.stderr, /PG_CONTAINER/);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('docker|exec')),
      false,
    );
  });

  it('uses PG_CONTAINER when several postgres containers run', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3'], {
      NTD_CONTAINERS: TWO_STACKS,
      PG_CONTAINER: 'other-wt-postgres-1',
    });

    assert.equal(result.status, 0, result.stderr);
    const execs = logLines(fixture.log).filter((line) => line.startsWith('docker|exec'));
    assert.ok(execs.length >= 2);
    for (const line of execs) assert.match(line, /^docker\|exec\|other-wt-postgres-1\|/);
  });

  it('narrows several containers to the COMPOSE_PROJECT_NAME stack', () => {
    const fixture = newTestDbFixture(`${DOTENV}COMPOSE_PROJECT_NAME=other-wt\n`);
    const result = provision(fixture, ['wave3'], { NTD_CONTAINERS: TWO_STACKS });

    assert.equal(result.status, 0, result.stderr);
    for (const line of logLines(fixture.log).filter((entry) => entry.startsWith('docker|exec'))) {
      assert.match(line, /^docker\|exec\|other-wt-postgres-1\|/);
    }
  });

  it('fails clearly when no postgres container runs', () => {
    const fixture = newTestDbFixture(DOTENV);
    const result = provision(fixture, ['wave3'], { NTD_CONTAINERS: 'unrelated-redis-1' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no running postgres container found/);
  });

  it('prints the chosen container for --container and applies the same ambiguity check', () => {
    const fixture = newTestDbFixture(DOTENV);
    const single = provision(fixture, ['--container']);
    assert.equal(single.status, 0, single.stderr);
    assert.equal(single.stdout, 'squad-admin-panel-postgres-1\n');

    const ambiguous = provision(fixture, ['--container'], { NTD_CONTAINERS: TWO_STACKS });
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /several postgres containers are running/);
  });

  it('applies the same container choice to --drop', () => {
    const fixture = newTestDbFixture(DOTENV);
    const ambiguous = provision(fixture, ['--drop', 'wave3'], { NTD_CONTAINERS: TWO_STACKS });
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /several postgres containers are running/);

    const chosen = provision(fixture, ['--drop', 'wave3'], {
      NTD_CONTAINERS: TWO_STACKS,
      PG_CONTAINER: 'other-wt-postgres-1',
    });
    assert.equal(chosen.status, 0, chosen.stderr);
    assert.ok(
      logLines(fixture.log).some(
        (line) =>
          line.startsWith('docker|exec|other-wt-postgres-1|') &&
          line.includes('DROP DATABASE IF EXISTS "test_wave3" WITH (FORCE)'),
      ),
    );
  });
});
