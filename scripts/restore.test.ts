import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { copyScript, executable, logLines, run, shimDirectory } from './test-helpers/ops.ts';

/**
 * `scripts/restore.sh --apply` against stand-in tools (#48). The `docker` shim
 * answers the compose queries, emulates the backup container's staging run by
 * writing the dumps into the fixture's backup-dump volume, and runs the Redis
 * conversion script for real under `sh` with fake `redis-server`/`redis-cli`,
 * so the bounded waits are exercised as shipped. Multi-line `-c` scripts are
 * logged as `SCRIPT:<kind>` and saved whole under `scripts/<n>.sh`.
 */
describe('restore apply: staging, worker pause, transactional pg_restore, Redis rollback', () => {
  function restoreFixture(): {
    root: string;
    script: string;
    log: string;
    dataDir: string;
    env: NodeJS.ProcessEnv;
  } {
    const { root, script } = copyScript('scripts/restore.sh');
    const dataDir = path.join(root, 'data');
    mkdirSync(path.join(dataDir, 'redis/appendonlydir'), { recursive: true });
    writeFileSync(path.join(dataDir, 'redis/appendonlydir/live.aof'), 'live aof');
    writeFileSync(path.join(dataDir, 'redis/dump.rdb'), 'live rdb');
    mkdirSync(path.join(dataDir, 'backup-dump'), { recursive: true });
    writeFileSync(path.join(root, '.env'), `DATA_DIR=${dataDir}\nPOSTGRES_PASSWORD=x\n`);
    const shims = shimDirectory();
    const log = path.join(root, 'commands.log');
    const savedScripts = path.join(root, 'scripts-run');
    mkdirSync(savedScripts);
    executable(
      path.join(shims, 'docker'),
      [
        'body=""',
        'line=docker',
        'previous=""',
        'for argument in "$@"; do',
        '  if [[ "$previous" == "-c" ]]; then',
        '    body=$argument',
        '    case "$argument" in',
        "      *'restic restore'*) kind=stage ;;",
        '      *pg_restore*) kind=pg_restore ;;',
        '      *redis-server*) kind=redis ;;',
        '      */data/pre-restore\\ ]*) kind=redis_guard ;;',
        '      *) kind=other ;;',
        '    esac',
        '    argument="SCRIPT:$kind"',
        '  fi',
        '  line="$line|$argument"',
        '  previous=$argument',
        'done',
        `printf "%s\\n" "$line" >> "\${OPS_LOG:?}"`,
        'if [[ -n "$body" ]]; then',
        '  printf "%s" "$body" > "$OPS_SCRIPTS/$(grep -c . "$OPS_LOG").sh"',
        'fi',
        'case "$line" in',
        "  *'|ps|--format|'*) printf 'postgres healthy\\nredis healthy\\n' ;;",
        "  *'|ps|--services|--status|running'*) printf 'caddy\\napi\\nworker-rcon\\npostgres\\nredis\\nworker-log-ingest\\n' ;;",
        '  *SCRIPT:stage*)',
        `    [[ "\${STAGE_EXIT:-0}" == 0 ]] || exit "$STAGE_EXIT"`,
        '    mkdir -p "$OPS_DATA/backup-dump/restore"',
        '    printf "restored pg" > "$OPS_DATA/backup-dump/restore/admin.dump"',
        `    [[ -n "\${STAGE_NO_RDB:-}" ]] || printf "restored rdb" > "$OPS_DATA/backup-dump/restore/dump.rdb"`,
        '    ;;',
        `  *SCRIPT:pg_restore*) exit "\${PG_RESTORE_EXIT:-0}" ;;`,
        '  *SCRIPT:redis_guard*) [[ ! -e "$OPS_DATA/redis/pre-restore" ]] || exit 1 ;;',
        // Stands in for the one-off container: its /data is the redis volume
        // and /restore the staged dumps. The fixture path contains spaces, so
        // the script sees both through space-free symlinks.
        '  *SCRIPT:redis*)',
        '    view=$(mktemp -d /tmp/ops-redis-view.XXXXXX)',
        '    ln -s "$OPS_DATA/redis" "$view/data"',
        '    ln -s "$OPS_DATA/backup-dump/restore" "$view/restore"',
        '    status=0',
        '    sh -c "$(printf "%s" "$body" | sed -e "s#/restore#$view/restore#g" -e "s#/data#$view/data#g")" || status=$?',
        '    rm -rf "$view"',
        '    exit "$status"',
        '    ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    const serverPid = path.join(root, 'redis-server.pid');
    executable(
      path.join(shims, 'redis-server'),
      [
        `printf '%s' "$$" > '${serverPid}'`,
        `if [[ -n "\${REDIS_SERVER_CRASH:-}" ]]; then exit 1; fi`,
        'exec /bin/sleep 30',
      ].join('\n'),
    );
    executable(
      path.join(shims, 'redis-cli'),
      [
        'case "$1" in',
        `  ping) [[ -n "\${REDIS_NO_PONG:-}\${REDIS_SERVER_CRASH:-}" ]] || printf "PONG\\n" ;;`,
        "  info) printf 'aof_rewrite_in_progress:0\\r\\naof_last_bgrewrite_status:ok\\r\\n' ;;",
        `  shutdown) kill "$(cat '${serverPid}')" 2>/dev/null ;;`,
        'esac',
        'exit 0',
      ].join('\n'),
    );
    executable(path.join(shims, 'sleep'), 'exit 0');
    return {
      root,
      script,
      log,
      dataDir,
      env: {
        OPS_LOG: log,
        OPS_DATA: dataDir,
        OPS_SCRIPTS: savedScripts,
        PATH: `${shims}:/usr/bin:/bin`,
      },
    };
  }

  const apply = (fixture: ReturnType<typeof restoreFixture>, env: NodeJS.ProcessEnv = {}) =>
    run('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: { ...fixture.env, ...env },
    });

  const indexOf = (commands: string[], pattern: RegExp): number =>
    commands.findIndex((line) => pattern.test(line));

  it('stages both dumps first, pauses only the workers, restores Postgres in one transaction', () => {
    const fixture = restoreFixture();
    const result = apply(fixture);
    assert.equal(result.status, 0, result.stderr);
    const commands = logLines(fixture.log);

    const stage = indexOf(commands, /SCRIPT:stage/);
    const stopWorkers = commands.indexOf(
      'docker|compose|--profile|backup|stop|worker-rcon|worker-log-ingest',
    );
    const pgRestore = indexOf(commands, /SCRIPT:pg_restore/);
    const stopRedis = commands.indexOf('docker|compose|--profile|backup|stop|redis');
    const startWorkers = commands.indexOf(
      'docker|compose|--profile|backup|start|worker-rcon|worker-log-ingest',
    );
    assert.ok(stage >= 0 && stage < stopWorkers, commands.join('\n'));
    assert.ok(stopWorkers < pgRestore && pgRestore < stopRedis, commands.join('\n'));
    assert.equal(startWorkers, commands.length - 1, commands.join('\n'));
    // The api holds the bridge connection that keeps this script alive.
    assert.equal(
      commands.some((line) => /\|stop\|.*\b(api|web|caddy|postgres)\b/.test(line)),
      false,
    );

    const pgScript = readFileSync(
      path.join(fixture.root, 'scripts-run', `${pgRestore + 1}.sh`),
      'utf8',
    );
    assert.match(pgScript, /pg_restore --single-transaction --exit-on-error --clean --if-exists/);

    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'),
      'restored rdb',
    );
    assert.equal(existsSync(path.join(fixture.dataDir, 'redis/appendonlydir')), false);
    assert.equal(existsSync(path.join(fixture.dataDir, 'redis/pre-restore')), false);
    assert.equal(existsSync(path.join(fixture.dataDir, 'backup-dump/restore')), false);
    assert.ok(commands.includes('docker|compose|--profile|backup|up|-d|redis'));
  });

  it('checks the staged dump.rdb before touching Postgres, the workers or Redis', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { STAGE_NO_RDB: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staged dump\.rdb missing/);
    const commands = logLines(fixture.log);
    assert.equal(indexOf(commands, /SCRIPT:pg_restore/), -1, commands.join('\n'));
    assert.equal(indexOf(commands, /\|stop\|/), -1, commands.join('\n'));
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'redis/appendonlydir/live.aof'), 'utf8'),
      'live aof',
    );
  });

  it('starts the workers again and leaves Redis alone when pg_restore fails', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { PG_RESTORE_EXIT: '3' });
    assert.equal(result.status, 3);
    const commands = logLines(fixture.log);
    assert.equal(commands.includes('docker|compose|--profile|backup|stop|redis'), false);
    assert.equal(
      commands.at(-1),
      'docker|compose|--profile|backup|start|worker-rcon|worker-log-ingest',
    );
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
    assert.equal(existsSync(path.join(fixture.dataDir, 'backup-dump/restore')), false);
  });

  it('puts the previous Redis dataset back and restarts redis when the RDB will not load', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { REDIS_SERVER_CRASH: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /redis-server exited while loading dump\.rdb/);
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'redis/appendonlydir/live.aof'), 'utf8'),
      'live aof',
    );
    assert.equal(existsSync(path.join(fixture.dataDir, 'redis/pre-restore')), false);
    const commands = logLines(fixture.log);
    const upRedis = commands.lastIndexOf('docker|compose|--profile|backup|up|-d|redis');
    assert.ok(upRedis > indexOf(commands, /SCRIPT:redis/), commands.join('\n'));
    assert.equal(
      commands.at(-1),
      'docker|compose|--profile|backup|start|worker-rcon|worker-log-ingest',
    );
  });

  it('gives up on a redis-server that never answers instead of waiting forever', () => {
    const fixture = restoreFixture();
    const result = apply(fixture, { REDIS_NO_PONG: '1', REDIS_READY_ATTEMPTS: '5' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not answer PING after 5 attempts/);
    assert.equal(readFileSync(path.join(fixture.dataDir, 'redis/dump.rdb'), 'utf8'), 'live rdb');
  });

  it('passes an ENV_FILE override to compose unless the bridge set COMPOSE_ENV_FILES', () => {
    const fixture = restoreFixture();
    writeFileSync(path.join(fixture.root, '.env.stand'), `DATA_DIR=${fixture.dataDir}\n`);
    const composeCalls = (env: NodeJS.ProcessEnv): string[] => {
      const result = run('/bin/bash', [fixture.script], {
        cwd: fixture.root,
        env: { ...fixture.env, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return logLines(fixture.log).filter((line) => line.startsWith('docker|compose'));
    };

    const override = composeCalls({ ENV_FILE: '.env.stand', COMPOSE_ENV_FILES: '' });
    assert.ok(
      override.length > 0 && override.every((line) => line.includes('|--env-file|.env.stand|')),
    );
    writeFileSync(fixture.log, '');
    // --env-file would replace COMPOSE_ENV_FILES and drop the stand's .release.env.
    const bridge = composeCalls({
      ENV_FILE: '.env.stand',
      COMPOSE_ENV_FILES: '.env.stand,.release.env',
    });
    assert.ok(bridge.length > 0 && bridge.every((line) => !line.includes('--env-file')));
  });

  it('refuses to run over the moved-aside dataset of an interrupted restore', () => {
    const fixture = restoreFixture();
    mkdirSync(path.join(fixture.dataDir, 'redis/pre-restore'));
    const result = apply(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interrupted restore/);
    const commands = logLines(fixture.log);
    assert.equal(indexOf(commands, /SCRIPT:stage/), -1, commands.join('\n'));
    assert.equal(indexOf(commands, /\|stop\|/), -1, commands.join('\n'));
  });
});
