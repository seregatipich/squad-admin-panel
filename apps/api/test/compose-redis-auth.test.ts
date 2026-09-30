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

const REPO_ROOT = resolve(__dirname, '../../..');
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

/** The redis service's exec-form command as a list of unquoted arguments. */
function redisCommand(yaml: string): string[] {
  const block = serviceBlock(yaml, 'redis');
  const lines = block.split('\n');
  const start = lines.findIndex((l) => /^ {4}command:\s*$/.test(l));
  if (start === -1) return [];
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
      expect(url).toMatch(/^redis:\/\/:\$\{REDIS_PASSWORD\}@(redis|127\.0\.0\.1):6379$/);
    }
  });

  it('hands the sidecar only the restricted rnsquadjs credentials', () => {
    expect(serviceBlock(yaml, 'api')).toMatch(
      /^ {6}SIDECAR_REDIS_URL: redis:\/\/rnsquadjs:\$\{REDIS_SIDECAR_PASSWORD\}@127\.0\.0\.1:6379$/m,
    );
  });
});

describe('docker/compose.yml — backup service', () => {
  it('authenticates the redis-cli --rdb dump', () => {
    const yaml = readFileSync(resolve(REPO_ROOT, 'docker/compose.yml'), 'utf-8');
    expect(serviceBlock(yaml, 'backup')).toMatch(/^ {6}REDISCLI_AUTH: \$\{REDIS_PASSWORD\}$/m);
  });
});
