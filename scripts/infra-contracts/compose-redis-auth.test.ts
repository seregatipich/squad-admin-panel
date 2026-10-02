import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for #32 (findings #1025, #1032, #1263): Redis is published
 * on the host loopback and the bridge runs the game servers and the rnsquadjs
 * sidecar with `--network host`, so an unauthenticated Redis handed every
 * host-network process the session cache, the event streams and the pub/sub
 * bus. Both compose files must require a password for the default user, give
 * the third-party sidecar its own ACL user limited to its keys, and pass the
 * matching credentials in every Redis URL.
 *
 * Line-based parsing, like compose-stand-worker-parity.test.ts, instead of a
 * YAML dependency.
 */

const REPO_ROOT = resolve(__dirname, '../..');
// compose.yml publishes Redis on ${REDIS_HOST_PORT:-6379} (worktree isolation); the stand file pins 6379.
const COMPOSE_FILES = ['docker/compose.yml', 'docker/compose.stand.yml'];

function serviceBlock(yaml: string, name: string): string {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`service ${name} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i] ?? '') || /^ {2}\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Splits a shell line into words, honouring single quotes and dropping line continuations. */
function shellWords(line: string): string[] {
  return [...line.replace(/\\\n/g, ' ').matchAll(/'([^']*)'|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? '',
  );
}

/**
 * The redis service's `redis-server` arguments as a list of unquoted words:
 * either the exec-form list (docker/compose.yml) or the final `exec
 * docker-entrypoint.sh redis-server ...` statement of the stand's `sh -c`
 * bootstrap script, which first converts an existing RDB into the AOF (#47).
 */
function redisCommand(yaml: string): string[] {
  const block = serviceBlock(yaml, 'redis');
  const lines = block.split('\n');
  const start = lines.findIndex((l) => /^ {4}command:\s*$/.test(l));
  if (start === -1) return [];
  const script = lines.findIndex((l) => /^ {8}exec docker-entrypoint\.sh redis-server /.test(l));
  if (script !== -1) {
    let statement = '';
    for (const line of lines.slice(script)) {
      statement += `${line}\n`;
      if (!line.trimEnd().endsWith('\\')) break;
    }
    const words = shellWords(statement);
    return words.slice(words.indexOf('redis-server'));
  }
  const args: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^ {6}- (.*)$/.exec(line);
    if (!item?.[1]) break;
    args.push(item[1].replace(/^'(.*)'$/, '$1'));
  }
  return args;
}

/** Arguments of the `--user rnsquadjs ...` directive, up to the next `--` flag. */
function sidecarAclRules(args: string[]): string[] {
  const at = args.findIndex((a, i) => a === '--user' && args[i + 1] === 'rnsquadjs');
  if (at === -1) return [];
  const rest = args.slice(at + 2);
  const next = rest.findIndex((a) => a.startsWith('--'));
  return next === -1 ? rest : rest.slice(0, next);
}

describe.each(COMPOSE_FILES)('%s — authenticated Redis', (file) => {
  const yaml = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
  const command = redisCommand(yaml);

  it('requires REDIS_PASSWORD for the default user', () => {
    const at = command.indexOf('--requirepass');
    expect(at).toBeGreaterThan(-1);
    expect(command[at + 1]).toMatch(/^\$\{REDIS_PASSWORD:\?[^}]+\}$/);
  });

  it('gives the sidecar a password-protected ACL user limited to its own keys', () => {
    const rules = sidecarAclRules(command);
    expect(rules).toContain('on');
    expect(rules.find((r) => r.startsWith('>'))).toMatch(/^>\$\{REDIS_SIDECAR_PASSWORD:\?[^}]+\}$/);
    expect(rules.filter((r) => r.startsWith('~')).sort()).toEqual([
      '~events:server:*',
      '~rnsquadjs:status:*',
      '~worker:heartbeat:rnsquadjs:*',
    ]);
    expect(rules).toContain('resetchannels');
    for (const broad of ['~*', 'allkeys', '&*', 'allchannels', '+@all', 'allcommands', 'nopass']) {
      expect(rules).not.toContain(broad);
    }
    expect(rules.filter((r) => r.startsWith('+')).sort()).toEqual([
      '+info',
      '+ping',
      '+quit',
      '+set',
      '+xadd',
    ]);
  });

  it('lets redis-cli in the redis container (healthcheck, exec) authenticate', () => {
    expect(serviceBlock(yaml, 'redis')).toMatch(/^ {6}REDISCLI_AUTH: \$\{REDIS_PASSWORD\}$/m);
  });

  it('authenticates every panel REDIS_URL with REDIS_PASSWORD', () => {
    const urls = [...yaml.matchAll(/^\s+REDIS_URL: (\S+)$/gm)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^redis:\/\/:\$\{REDIS_PASSWORD\}@(redis:6379|127\.0\.0\.1:(6379|\$\{REDIS_HOST_PORT:-6379\}))$/,
      );
    }
  });

  it('hands the sidecar only the restricted rnsquadjs credentials', () => {
    expect(serviceBlock(yaml, 'api')).toMatch(
      /^ {6}SIDECAR_REDIS_URL: redis:\/\/rnsquadjs:\$\{REDIS_SIDECAR_PASSWORD\}@127\.0\.0\.1:(6379|\$\{REDIS_HOST_PORT:-6379\})$/m,
    );
  });
});

describe('docker/compose.yml — backup service', () => {
  it('authenticates the redis-cli --rdb dump', () => {
    const yaml = readFileSync(resolve(REPO_ROOT, 'docker/compose.yml'), 'utf-8');
    expect(serviceBlock(yaml, 'backup')).toMatch(/^ {6}REDISCLI_AUTH: \$\{REDIS_PASSWORD\}$/m);
  });
});

describe.each(COMPOSE_FILES)('%s — no unauthenticated Redis URL anywhere', (file) => {
  it('gives every redis:// literal credentials, whatever the variable is called', () => {
    const yaml = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
    const urls = [...yaml.matchAll(/redis:\/\/[^\s'"]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^redis:\/\/(:\$\{REDIS_PASSWORD\}|rnsquadjs:\$\{REDIS_SIDECAR_PASSWORD\})@/,
      );
    }
  });
});

describe('scripts/test-backup-restore.sh — mirrors the authenticated Redis (#97)', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/test-backup-restore.sh'), 'utf-8');
  const code = script.split('\n').filter((l) => !/^\s*#/.test(l));

  it('starts every long-running redis-server with --requirepass', () => {
    const servers = code.filter((l) => /^\s*("\$RD_IMG" )?redis-server /.test(l));
    expect(servers.length).toBe(2);
    for (const line of servers) expect(line).toContain('--requirepass "$REDIS_PW"');
  });

  it('hands REDISCLI_AUTH to every redis-cli caller', () => {
    const execs = code.filter((l) => /docker exec .*\bredis-cli\b/.test(l));
    expect(execs.length).toBeGreaterThanOrEqual(3);
    for (const line of execs) expect(line).toContain('-e REDISCLI_AUTH="$REDIS_PW"');
    // The toolbox runs the PRE_COMMANDS dump; the one-off container converts the RDB.
    expect(script).toMatch(/-e RESTIC_PASSWORD=citest -e REDISCLI_AUTH="\$REDIS_PW"/);
    expect(script).toMatch(/-e REDISCLI_AUTH="\$REDIS_PW" -e REDIS_READY_ATTEMPTS/);
  });
});
