import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  type CommandResult,
  copyScript,
  executable,
  loggingShim,
  logLines,
  REPOSITORY_ROOT,
  runAsync,
  shimDirectory,
} from './test-helpers/ops.ts';
import { IMAGE_REPO, imageRef, RELEASE_SHA } from './test-helpers/stand-release.ts';

const NEXT_SHA = 'c'.repeat(40);
const IMAGES = [
  ['API_IMAGE', 'api'],
  ['WEB_IMAGE', 'web'],
  ['WORKERS_IMAGE', 'workers'],
  ['CADDY_IMAGE', 'caddy'],
] as const;
type ImageKey = (typeof IMAGES)[number][0];

/** The four image variables of a release, each digest filled with `fill` unless overridden. */
function releaseImages(
  fill = '1',
  overrides: Partial<Record<ImageKey, string>> = {},
): Record<ImageKey, string> {
  return Object.fromEntries(
    IMAGES.map(([key, name]) => [key, overrides[key] ?? imageRef(name, fill)]),
  ) as Record<ImageKey, string>;
}

/**
 * Stand-ins for the host's tools. `docker` answers the handful of queries the
 * deploy makes: `compose ps -a` reports DOCKER_IDS_BEFORE until `up -d
 * --remove-orphans` has run and DOCKER_IDS_AFTER afterwards (a changed ID is a
 * recreated container), `compose ps` reports DOCKER_HEALTH, `image inspect`
 * succeeds only for references in DOCKER_PRESENT, and `image ls <repo>` lists
 * the IDs in DOCKER_REPO_IDS that belong to <repo>. `curl` answers /health with
 * the APP_VERSION the deploy is rolling out, as the recreated api would.
 */
function hostShims(): string {
  const shims = shimDirectory();
  loggingShim(
    shims,
    'docker',
    [
      `last="\${@: -1}"`,
      `if [[ "$*" == 'compose version --short' ]]; then printf '%s\\n' "\${DOCKER_COMPOSE_VERSION-2.29.7}"; exit 0; fi`,
      `if [[ -n "\${FAIL_DOCKER_MATCH:-}" && "$*" == *"$FAIL_DOCKER_MATCH"* ]]; then exit "\${FAIL_CODE:-41}"; fi`,
      `ids='postgres p1,redis r1,api a1,web w1,caddy c1,worker-rcon k1'`,
      `health='postgres running healthy,redis running healthy,api running healthy,web running healthy,caddy running ,worker-rcon running '`,
      'case "$*" in',
      `  *'ps -a --format'*)`,
      `    if grep -qF '|up|-d|--remove-orphans' "$OPS_LOG"; then ids="\${DOCKER_IDS_AFTER:-$ids}"; else ids="\${DOCKER_IDS_BEFORE:-$ids}"; fi`,
      `    printf '%s\\n' "$ids" | tr ',' '\\n' ;;`,
      `  *'ps --format'*) printf '%s\\n' "\${DOCKER_HEALTH:-$health}" | tr ',' '\\n' ;;`,
      `  *pg_dump*) printf 'PGDMP' ;;`,
      `  'image inspect'*)`,
      `    case ",\${DOCKER_PRESENT:-}," in *",$last,"*) ;; *) exit 1 ;; esac`,
      `    if [[ "$*" == *--format* ]]; then printf 'id:%s\\n' "$last"; fi ;;`,
      `  'image ls'*)`,
      `    for id in \${DOCKER_REPO_IDS//,/ }; do if [[ "$id" == "id:$last"[@:]* ]]; then printf '%s\\n' "$id"; fi; done ;;`,
      'esac',
      'exit 0',
    ].join('\n'),
  );
  loggingShim(shims, 'sleep');
  // CURL_FAIL_TIMES makes the first N probes fail with CURL_EXIT and every
  // later one succeed, modelling caddy finishing its TLS handshake mid-deploy;
  // CURL_EXIT alone fails every probe.
  loggingShim(
    shims,
    'curl',
    [
      `attempts_file="\${OPS_LOG:?}.curl-attempts"`,
      'attempts=$(( $(cat "$attempts_file" 2>/dev/null || echo 0) + 1 ))',
      'printf "%s" "$attempts" > "$attempts_file"',
      `if [[ -n "\${CURL_FAIL_TIMES:-}" ]]; then`,
      `  if [[ "$attempts" -le "$CURL_FAIL_TIMES" ]]; then exit "\${CURL_EXIT:-35}"; fi`,
      `elif [[ -n "\${CURL_EXIT:-}" ]]; then exit "$CURL_EXIT"; fi`,
      `version="\${CURL_VERSION:-$(sed -n 's/^APP_VERSION=//p' "$APP_DIR/.release.next.env" 2>/dev/null)}"`,
      `printf '{"status":"ok","uptime_s":1,"version":"%s"}' "$version"`,
    ].join('\n'),
  );
  // Linux has sha256sum on the test PATH; macOS keeps it in /sbin (14+) or
  // only offers shasum.
  if (!existsSync('/usr/bin/sha256sum') && !existsSync('/bin/sha256sum')) {
    if (existsSync('/sbin/sha256sum')) {
      symlinkSync('/sbin/sha256sum', path.join(shims, 'sha256sum'));
    } else {
      executable(path.join(shims, 'sha256sum'), 'exec /usr/bin/shasum -a 256 "$@"');
    }
  }
  return shims;
}

interface DeployFixture {
  root: string;
  script: string;
  log: string;
  backups: string;
  env: NodeJS.ProcessEnv;
}

/** An app directory with the files the deploy hashes, and host tool shims. */
function deployFixture(): DeployFixture {
  const { root, script } = copyScript('scripts/deploy-stand.sh');
  writeFileSync(
    path.join(root, '.env.stand'),
    'SAFE_TEST_VALUE=1\nAPP_DOMAIN=stand.example\nACME_EMAIL=ops@stand.example\nDUCKDNS_TOKEN=token-value\n',
  );
  mkdirSync(path.join(root, 'docker'));
  writeFileSync(path.join(root, 'docker/compose.stand.yml'), 'services: {}\n');
  writeFileSync(path.join(root, 'docker/Caddyfile.stand'), '{$APP_DOMAIN} {}\n');
  mkdirSync(path.join(root, 'packages/db/drizzle/meta'), { recursive: true });
  writeFileSync(path.join(root, 'packages/db/drizzle/0000_init.sql'), 'CREATE TABLE t ();\n');
  writeFileSync(path.join(root, 'packages/db/drizzle/meta/_journal.json'), '{"entries":[]}\n');
  const log = path.join(root, 'commands.log');
  const backups = path.join(root, 'backups');
  return {
    root,
    script,
    log,
    backups,
    env: {
      OPS_LOG: log,
      APP_DIR: root,
      BACKUP_DIR: backups,
      HEALTH_TIMEOUT: '3',
      PATH: `${hostShims()}:/usr/bin:/bin`,
      RELEASE_SHA,
      ...releaseImages(),
    },
  };
}

/** Runs one deploy with a fresh command log, as each deploy is its own SSH session. */
function deploy(
  fixture: DeployFixture,
  env: NodeJS.ProcessEnv = {},
  script = fixture.script,
): Promise<CommandResult> {
  rmSync(fixture.log, { force: true });
  rmSync(`${fixture.log}.curl-attempts`, { force: true });
  return runAsync('/bin/bash', [script], { env: { ...fixture.env, ...env } });
}

function releaseFile(fixture: DeployFixture, name = '.release.env'): Record<string, string> {
  const entries = readFileSync(path.join(fixture.root, name), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
  return Object.fromEntries(entries);
}

function dockerCommands(log: string): string[] {
  return logLines(log).filter((line) => line.startsWith('docker|'));
}

const COMPOSE =
  'docker|compose|--env-file|.env.stand|--env-file|.release.next.env|-f|docker/compose.stand.yml';

describe('the stand host release deploy', { concurrency: true }, () => {
  it('fails before Docker when the deployment environment file is absent', async () => {
    const { root, script } = copyScript('scripts/deploy-stand.sh');
    const result = await runAsync('/bin/bash', [script], { env: { APP_DIR: root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.stand is missing/);
  });

  it('refuses a malformed release or image reference before any Docker call', async () => {
    const fixture = deployFixture();
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ RELEASE_SHA: '' }, /RELEASE_SHA must name the release/],
      [{ RELEASE_SHA: 'bad sha' }, /RELEASE_SHA must name the release/],
      [{ RELEASE_SHA: '-leading-dash' }, /RELEASE_SHA must name the release/],
      [{ API_IMAGE: '' }, /API_IMAGE must be an image reference/],
      [{ WEB_IMAGE: `${IMAGE_REPO}-web` }, /WEB_IMAGE must be an image reference/],
      [{ WORKERS_IMAGE: `${IMAGE_REPO}-workers@sha256:abc` }, /WORKERS_IMAGE must be/],
      [{ CADDY_IMAGE: `$(touch ${fixture.root}/pwned)@sha256:${'1'.repeat(64)}` }, /CADDY_IMAGE/],
      [{ API_IMAGE: `GHCR.IO/x/api@sha256:${'1'.repeat(64)}` }, /API_IMAGE must be/],
    ];
    for (const [env, message] of cases) {
      const result = await deploy(fixture, env);
      assert.equal(result.status, 1, JSON.stringify(env));
      assert.match(result.stderr, message);
      assert.deepEqual(logLines(fixture.log), [], JSON.stringify(env));
    }
    assert.equal(existsSync(path.join(fixture.root, 'pwned')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it("refuses to start without the stand's APP_DOMAIN in .env.stand", async () => {
    for (const content of ['SAFE_TEST_VALUE=1\n', 'APP_DOMAIN=stand.example;id\n']) {
      const fixture = deployFixture();
      writeFileSync(path.join(fixture.root, '.env.stand'), content);
      const result = await deploy(fixture);
      assert.equal(result.status, 1, content);
      assert.match(result.stderr, /APP_DOMAIN in .*\.env\.stand must be the stand's host name/);
      assert.deepEqual(logLines(fixture.log), [], content);
    }
  });

  it('generates missing Redis secrets into .env.stand once and never rotates them', async () => {
    const fixture = deployFixture();
    const envFile = path.join(fixture.root, '.env.stand');
    writeFileSync(
      envFile,
      'SAFE_TEST_VALUE=1\nREDIS_SIDECAR_PASSWORD=\nACME_EMAIL=ops@stand.example\nDUCKDNS_TOKEN=token-value\nAPP_DOMAIN=stand.example',
    );
    const secrets = () =>
      Object.fromEntries(
        readFileSync(envFile, 'utf8')
          .split('\n')
          .filter((line) => /^REDIS_(SIDECAR_)?PASSWORD=/.test(line))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
    const env = { DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a2,web w2,caddy c2,worker-rcon k2' };

    const first = await deploy(fixture, env);
    assert.equal(first.status, 0, first.stderr);
    const generated = secrets();
    assert.match(generated.REDIS_PASSWORD ?? '', /^[0-9a-f]{64}$/);
    assert.match(generated.REDIS_SIDECAR_PASSWORD ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(generated.REDIS_PASSWORD, generated.REDIS_SIDECAR_PASSWORD);
    const lines = readFileSync(envFile, 'utf8').split('\n');
    assert.ok(lines.includes('APP_DOMAIN=stand.example'), 'the last line kept its value');
    assert.equal(lines.filter((line) => line.startsWith('REDIS_SIDECAR_PASSWORD=')).length, 1);

    const second = await deploy(fixture, env);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(secrets(), generated);
    assert.doesNotMatch(second.stdout, /generated REDIS/);
  });

  it('deploys from a pre-Redis-auth .env.stand without either secret and keeps existing values (#97)', async () => {
    const fixture = deployFixture();
    const envFile = path.join(fixture.root, '.env.stand');
    // An old stand file: neither key present, no trailing newline.
    writeFileSync(
      envFile,
      'ACME_EMAIL=ops@stand.example\nDUCKDNS_TOKEN=token-value\nAPP_DOMAIN=stand.example',
    );
    const env = { DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a2,web w2,caddy c2,worker-rcon k2' };
    const read = (key: string) =>
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith(`${key}=`));

    const first = await deploy(fixture, env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(read('REDIS_PASSWORD').length, 1);
    assert.equal(read('REDIS_SIDECAR_PASSWORD').length, 1);
    assert.match(read('REDIS_PASSWORD')[0] ?? '', /^REDIS_PASSWORD=[0-9a-f]{64}$/);

    // An operator-chosen password is never replaced, and a repeat deploy changes nothing.
    const before = readFileSync(envFile, 'utf8').replace(
      /^REDIS_PASSWORD=.*$/m,
      'REDIS_PASSWORD=operator-chosen',
    );
    writeFileSync(envFile, before);
    const second = await deploy(fixture, env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(envFile, 'utf8'), before);
  });

  it('refuses to start without a real ACME_EMAIL and a DUCKDNS_TOKEN in .env.stand', async () => {
    const base = 'APP_DOMAIN=stand.example\n';
    const cases: Array<[string, RegExp]> = [
      [`${base}DUCKDNS_TOKEN=t\n`, /ACME_EMAIL in .*\.env\.stand must be set/],
      [`${base}ACME_EMAIL=ops@stand.example\n`, /DUCKDNS_TOKEN in .*\.env\.stand must be set/],
      [
        `${base}ACME_EMAIL=admin@example.com\nDUCKDNS_TOKEN=t\n`,
        /ACME_EMAIL .* must be a real address/,
      ],
    ];
    for (const [content, message] of cases) {
      const fixture = deployFixture();
      writeFileSync(path.join(fixture.root, '.env.stand'), content);
      const result = await deploy(fixture);
      assert.equal(result.status, 1, content);
      assert.match(result.stderr, message);
      assert.deepEqual(logLines(fixture.log), [], content);
    }
  });

  it('refuses a Compose too old to merge both env files, before changing anything', async () => {
    for (const version of ['2.16.0', 'v1.29.2', '']) {
      const fixture = deployFixture();
      const result = await deploy(fixture, { DOCKER_COMPOSE_VERSION: version });
      assert.equal(result.status, 1, version);
      assert.match(result.stderr, /Docker Compose 2\.17\+ is required/);
      assert.deepEqual(logLines(fixture.log), ['docker|compose|version|--short']);
      assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
    }
  });

  it('first release: pulls every image, backs up and migrates, starts, waits, records', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, {
      DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a2,web w2,caddy c2,worker-rcon k2',
    });
    assert.equal(result.status, 0, result.stderr);
    const images = releaseImages();
    assert.deepEqual(dockerCommands(fixture.log), [
      'docker|compose|version|--short',
      ...IMAGES.flatMap(([key]) => [
        `docker|image|inspect|${images[key]}`,
        `docker|pull|--quiet|${images[key]}`,
      ]),
      `${COMPOSE}|up|-d|postgres`,
      `${COMPOSE}|ps|--format|{{.Service}} {{.State}} {{.Health}}`,
      `${COMPOSE}|exec|-T|postgres|pg_dump|-U|admin|-d|admin|-Fc`,
      `${COMPOSE}|run|--rm|-T|migrator`,
      `${COMPOSE}|ps|-a|--format|{{.Service}} {{.ID}}`,
      `${COMPOSE}|up|-d|--remove-orphans`,
      `${COMPOSE}|ps|-a|--format|{{.Service}} {{.ID}}`,
      `${COMPOSE}|ps|--format|{{.Service}} {{.State}} {{.Health}}`,
      `${COMPOSE}|ps`,
      ...IMAGES.map(([key]) => `docker|image|inspect|--format|{{.Id}}|${images[key]}`),
      ...IMAGES.map(([, name]) => `docker|image|ls|--quiet|--no-trunc|${IMAGE_REPO}-${name}`),
    ]);
    assert.equal(
      logLines(fixture.log).some((line) => line.includes('|build')),
      false,
    );
    assert.match(result.stdout, /Recreated: api caddy web worker-rcon/);
    assert.match(result.stdout, new RegExp(`${RELEASE_SHA} is live`));

    const recorded = releaseFile(fixture);
    assert.deepEqual(Object.keys(recorded), [
      'RELEASE_SHA',
      'APP_VERSION',
      'API_IMAGE',
      'WEB_IMAGE',
      'WORKERS_IMAGE',
      'CADDY_IMAGE',
      'CADDYFILE_SHA',
      'MIGRATIONS_SHA',
      'COMPOSE_CONFIG_SHA',
    ]);
    assert.equal(recorded.RELEASE_SHA, RELEASE_SHA);
    assert.equal(recorded.APP_VERSION, RELEASE_SHA);
    for (const [key] of IMAGES) assert.equal(recorded[key], images[key]);
    for (const key of ['CADDYFILE_SHA', 'MIGRATIONS_SHA', 'COMPOSE_CONFIG_SHA']) {
      assert.match(recorded[key] ?? '', /^[0-9a-f]{64}$/, key);
    }
    assert.equal(existsSync(path.join(fixture.root, '.release.prev.env')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
    const dumps = readdirSync(fixture.backups);
    assert.equal(dumps.length, 1);
    assert.match(dumps[0] ?? '', /^panel-\d{8}T\d{6}Z-a{12}\.dump$/);
    assert.equal(readFileSync(path.join(fixture.backups, dumps[0] ?? ''), 'utf8'), 'PGDMP');
    // The dump holds the whole database, so only the deploy account reads it.
    assert.equal(statSync(path.join(fixture.backups, dumps[0] ?? '')).mode & 0o777, 0o600);
  });

  it('exits before any Docker call when a release changes no image and no configuration', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const first = releaseFile(fixture);

    const result = await deploy(fixture, { RELEASE_SHA: NEXT_SHA });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changes no image and no configuration: nothing to do/);
    assert.deepEqual(logLines(fixture.log), []);
    // The commit is recorded; the running api keeps reporting its own version.
    assert.deepEqual(releaseFile(fixture), { ...first, RELEASE_SHA: NEXT_SHA });
    assert.equal(existsSync(path.join(fixture.root, '.release.prev.env')), false);
  });

  it('pulls and recreates only what changed, keeping APP_VERSION while the api image stays', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const first = releaseFile(fixture);
    const webImage = imageRef('web', '2');

    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      WEB_IMAGE: webImage,
      DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a1,web w2,caddy c1,worker-rcon k1',
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = dockerCommands(fixture.log);
    assert.deepEqual(
      commands.filter((line) => line.startsWith('docker|pull|')),
      [`docker|pull|--quiet|${webImage}`],
    );
    assert.equal(
      commands.some((line) => /pg_dump|migrator|\|up\|-d\|postgres/.test(line)),
      false,
    );
    assert.equal(commands.filter((line) => line.endsWith('|up|-d|--remove-orphans')).length, 1);
    assert.match(result.stdout, /Recreated: web;/);

    const recorded = releaseFile(fixture);
    assert.equal(recorded.RELEASE_SHA, NEXT_SHA);
    assert.equal(recorded.APP_VERSION, RELEASE_SHA);
    assert.equal(recorded.WEB_IMAGE, webImage);
    assert.deepEqual(releaseFile(fixture, '.release.prev.env'), first);
  });

  it('reports the new commit once the api image changes', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      API_IMAGE: imageRef('api', '2'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(releaseFile(fixture).APP_VERSION, NEXT_SHA);
    assert.match(result.stdout, new RegExp(`APP_VERSION=${NEXT_SHA}`));
  });

  it('backs up and migrates before the new containers start, only when drizzle changed', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    mkdirSync(fixture.backups, { recursive: true });
    for (let day = 1; day <= 6; day += 1) {
      writeFileSync(path.join(fixture.backups, `panel-2020010${day}T000000Z-old.dump`), 'PGDMP');
    }
    writeFileSync(path.join(fixture.root, 'packages/db/drizzle/0001_next.sql'), 'ALTER TABLE t;\n');

    const result = await deploy(fixture, { RELEASE_SHA: NEXT_SHA });
    assert.equal(result.status, 0, result.stderr);
    const commands = dockerCommands(fixture.log);
    const dump = commands.findIndex((line) => line.includes('|pg_dump|'));
    const migrate = commands.indexOf(`${COMPOSE}|run|--rm|-T|migrator`);
    const up = commands.indexOf(`${COMPOSE}|up|-d|--remove-orphans`);
    assert.ok(dump >= 0 && migrate > dump && up > migrate, commands.join('\n'));
    assert.equal(
      commands.some((line) => line.startsWith('docker|pull|')),
      false,
    );
    // The newest five dumps survive: this deploy's, the first deploy's, and
    // the three most recent of the older ones.
    const dumps = readdirSync(fixture.backups).sort();
    assert.equal(dumps.length, 5, dumps.join('\n'));
    assert.deepEqual(dumps.slice(0, 3), [
      'panel-20200104T000000Z-old.dump',
      'panel-20200105T000000Z-old.dump',
      'panel-20200106T000000Z-old.dump',
    ]);
    assert.ok(dumps.some((name) => name.endsWith(`-${NEXT_SHA.slice(0, 12)}.dump`)));
    assert.notEqual(
      releaseFile(fixture).MIGRATIONS_SHA,
      releaseFile(fixture, '.release.prev.env').MIGRATIONS_SHA,
    );
  });

  it('stops before any app container is replaced when a migration fails', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const running = readFileSync(path.join(fixture.root, '.release.env'), 'utf8');
    writeFileSync(path.join(fixture.root, 'packages/db/drizzle/0001_next.sql'), 'ALTER TABLE t;\n');

    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      API_IMAGE: imageRef('api', '2'),
      FAIL_DOCKER_MATCH: 'run --rm -T migrator',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /migrations failed; no app container was recreated \(backup: /);
    const commands = dockerCommands(fixture.log);
    assert.ok(commands.some((line) => line.includes('|pg_dump|')));
    assert.equal(
      commands.some((line) => line.includes('--remove-orphans')),
      false,
    );
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('curl|')),
      false,
    );
    assert.equal(readFileSync(path.join(fixture.root, '.release.env'), 'utf8'), running);
    assert.equal(existsSync(path.join(fixture.root, '.release.prev.env')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
  });

  it('does not migrate when the pre-migration backup fails', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { FAIL_DOCKER_MATCH: 'pg_dump' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /database backup failed; nothing was migrated or recreated/);
    const commands = dockerCommands(fixture.log);
    assert.equal(
      commands.some((line) => line.includes('migrator') || line.includes('--remove-orphans')),
      false,
    );
    assert.deepEqual(readdirSync(fixture.backups), []);
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('applies a Caddyfile or .env.stand edit even when no image changed', async () => {
    for (const edited of ['docker/Caddyfile.stand', '.env.stand']) {
      const fixture = deployFixture();
      assert.equal((await deploy(fixture)).status, 0);
      const first = releaseFile(fixture);
      writeFileSync(path.join(fixture.root, edited), '# edited\n', { flag: 'a' });

      const result = await deploy(fixture, { RELEASE_SHA: NEXT_SHA });
      assert.equal(result.status, 0, result.stderr);
      const commands = dockerCommands(fixture.log);
      assert.ok(commands.includes(`${COMPOSE}|up|-d|--remove-orphans`), edited);
      assert.equal(
        commands.some((line) => line.startsWith('docker|pull|') || line.includes('migrator')),
        false,
      );
      const recorded = releaseFile(fixture);
      const hash = edited === '.env.stand' ? 'COMPOSE_CONFIG_SHA' : 'CADDYFILE_SHA';
      assert.notEqual(recorded[hash], first[hash], edited);
    }
  });

  it('fails closed when a recreated service never becomes ready, keeping the recorded release', async () => {
    const fixture = deployFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const running = readFileSync(path.join(fixture.root, '.release.env'), 'utf8');

    const result = await deploy(fixture, {
      RELEASE_SHA: NEXT_SHA,
      WEB_IMAGE: imageRef('web', '2'),
      DOCKER_IDS_AFTER: 'postgres p1,redis r1,api a1,web w2,caddy c1,worker-rcon k1',
      DOCKER_HEALTH: 'api running healthy,web running starting',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not ready after 3s: web\(running\/starting\)/);
    assert.equal(logLines(fixture.log).filter((line) => line.startsWith('sleep|')).length, 3);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('curl|')),
      false,
    );
    assert.doesNotMatch(result.stdout, /is live/);
    assert.equal(readFileSync(path.join(fixture.root, '.release.env'), 'utf8'), running);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
  });

  // regression (#290): the Caddy probe used to be a single-shot `curl -f`. The
  // api-health wait returns as soon as the api container is healthy, but caddy
  // starts in the same `up -d` and needs a moment more to bind 443, so the
  // probe raced the deploy it verifies. Run 31948383567 went red with curl
  // exit 35 (SSL connect error) 140 ms after caddy started, while the stack
  // was healthy and serving https://<APP_DOMAIN>/health with a 200.
  it('retries the Caddy probe while TLS is still coming up, then reports success', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { CURL_FAIL_TIMES: '3', CURL_EXIT: '35' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /is live/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('curl|'));
    assert.equal(probes.length, 4, 'expected 3 failed probes then one success');
    assert.ok(probes.every((line) => line.includes('|--resolve|stand.example:443:127.0.0.1|')));
  });

  it('still fails closed, preserving the curl exit code, when the probe never recovers', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { CURL_EXIT: '35' });
    assert.equal(result.status, 35);
    assert.match(
      result.stderr,
      /health probe through Caddy failed after 20 attempts \(curl exit 35/,
    );
    assert.doesNotMatch(result.stdout, /is live/);
    const probes = logLines(fixture.log).filter((line) => line.startsWith('curl|'));
    assert.equal(probes.length, 20, 'expected the retry budget to be exhausted');
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('fails when /health keeps reporting a version other than the recorded one', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, { CURL_VERSION: 'stale' });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`expected version ${RELEASE_SHA}, last response: .*"stale"`),
    );
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
  });

  it('propagates a failed start without probing or recording the release', async () => {
    const fixture = deployFixture();
    const result = await deploy(fixture, {
      FAIL_DOCKER_MATCH: 'up -d --remove-orphans',
      FAIL_CODE: '47',
    });
    assert.equal(result.status, 47);
    assert.equal(
      logLines(fixture.log).some((line) => line.startsWith('curl|')),
      false,
    );
    assert.equal(existsSync(path.join(fixture.root, '.release.env')), false);
    assert.equal(existsSync(path.join(fixture.root, '.release.next.env')), false);
  });

  it('removes panel images other than the running and the previous release', async () => {
    const fixture = deployFixture();
    const first = releaseImages('1');
    const second = releaseImages('1', { WEB_IMAGE: imageRef('web', '2') });
    const present = [...Object.values(first), second.WEB_IMAGE].join(',');
    const staleWeb = imageRef('web', '3');
    const staleApi = imageRef('api', '0');
    const repoIds = [...Object.values(first), second.WEB_IMAGE, staleWeb, staleApi]
      .map((reference) => `id:${reference}`)
      .join(',');
    assert.equal((await deploy(fixture, { DOCKER_PRESENT: present })).status, 0);

    const result = await deploy(fixture, {
      ...second,
      RELEASE_SHA: NEXT_SHA,
      DOCKER_PRESENT: present,
      DOCKER_REPO_IDS: repoIds,
    });
    assert.equal(result.status, 0, result.stderr);
    const removed = dockerCommands(fixture.log)
      .filter((line) => line.startsWith('docker|image|rm|'))
      .map((line) => line.split('|').at(-1));
    assert.deepEqual(removed.sort(), [`id:${staleApi}`, `id:${staleWeb}`].sort());
    // Already on the host, so nothing was pulled.
    assert.equal(
      dockerCommands(fixture.log).some((line) => line.startsWith('docker|pull|')),
      false,
    );
  });
});

describe('the stand host rollback', { concurrency: true }, () => {
  /** A deploy fixture with the real rollback script next to the real deploy script. */
  function rollbackFixture(): DeployFixture & { rollback: string } {
    const fixture = deployFixture();
    const rollback = path.join(fixture.root, 'scripts/rollback-stand.sh');
    copyFileSync(path.join(REPOSITORY_ROOT, 'scripts/rollback-stand.sh'), rollback);
    return { ...fixture, rollback };
  }

  it('redeploys the previous release and swaps the release files, without migrating', async () => {
    const fixture = rollbackFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const first = releaseFile(fixture);
    const second = releaseImages('2');
    assert.equal((await deploy(fixture, { ...second, RELEASE_SHA: NEXT_SHA })).status, 0);
    const current = releaseFile(fixture);
    assert.equal(current.APP_VERSION, NEXT_SHA);

    // Only the current images are still on the host: the previous ones are pulled.
    const result = await deploy(
      fixture,
      { DOCKER_PRESENT: Object.values(second).join(','), RELEASE_SHA: 'ignored' },
      fixture.rollback,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Rolling back ${NEXT_SHA} -> ${RELEASE_SHA}`));
    assert.deepEqual(releaseFile(fixture), first);
    assert.deepEqual(releaseFile(fixture, '.release.prev.env'), current);
    const commands = dockerCommands(fixture.log);
    assert.deepEqual(
      commands.filter((line) => line.startsWith('docker|pull|')),
      IMAGES.map(([key]) => `docker|pull|--quiet|${releaseImages('1')[key]}`),
    );
    assert.equal(
      commands.some((line) => line.includes('pg_dump') || line.includes('migrator')),
      false,
    );

    // A second rollback returns to where it started.
    assert.equal((await deploy(fixture, {}, fixture.rollback)).status, 0);
    assert.deepEqual(releaseFile(fixture), current);
  });

  it('refuses without a complete previous release, or onto the running one', async () => {
    const empty = rollbackFixture();
    const none = await deploy(empty, {}, empty.rollback);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no previous release recorded/);
    assert.deepEqual(logLines(empty.log), []);

    const partial = rollbackFixture();
    writeFileSync(path.join(partial.root, '.release.prev.env'), `RELEASE_SHA=${RELEASE_SHA}\n`);
    const incomplete = await deploy(partial, {}, partial.rollback);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /records no API_IMAGE/);
    assert.deepEqual(logLines(partial.log), []);

    const same = rollbackFixture();
    assert.equal((await deploy(same)).status, 0);
    copyFileSync(path.join(same.root, '.release.env'), path.join(same.root, '.release.prev.env'));
    const onto = await deploy(same, {}, same.rollback);
    assert.equal(onto.status, 1);
    assert.match(onto.stderr, /already the running release/);
    assert.deepEqual(logLines(same.log), []);
  });

  it('warns instead of silently redeploying a release it just rolled back away from (#76)', async () => {
    const fixture = rollbackFixture();
    assert.equal((await deploy(fixture)).status, 0);
    const second = releaseImages('2');
    assert.equal((await deploy(fixture, { ...second, RELEASE_SHA: NEXT_SHA })).status, 0);

    // Roll back NEXT_SHA -> RELEASE_SHA. deploy-stand.sh's unconditional
    // release-file swap now leaves .release.prev.env holding NEXT_SHA (the
    // release just left), so a follow-up rollback would read it straight
    // back out with no signal that it was ever rolled away from.
    const first = await deploy(
      fixture,
      { DOCKER_PRESENT: Object.values(second).join(',') },
      fixture.rollback,
    );
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(releaseFile(fixture, '.release.bad.env'), { RELEASE_SHA: NEXT_SHA });

    // A second rollback (the documented, tested round trip) targets
    // .release.prev.env, which now holds NEXT_SHA — exactly the release
    // .release.bad.env just recorded. It must still succeed (this round
    // trip is intended), but it must no longer be silent about redeploying
    // a release this script itself rolled away from.
    const second_rollback = await deploy(fixture, {}, fixture.rollback);
    assert.equal(second_rollback.status, 0, second_rollback.stderr);
    assert.match(second_rollback.stderr, /rolled back away from previously/);
    assert.deepEqual(releaseFile(fixture).APP_VERSION, NEXT_SHA);
  });
});
