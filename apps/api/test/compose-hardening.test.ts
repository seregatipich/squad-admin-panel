import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression cover for the infrastructure findings of #47, asserted on the
 * text of both compose files and the Dockerfiles (no YAML dependency, like
 * compose-bridge-perms.test.ts):
 *
 * - secrets: no well-known restic password, required secrets fail fast;
 * - the stand keeps Redis AOF persistence and has the backup service;
 * - containers drop every capability, cannot gain privileges, and run as a
 *   non-root user unless a comment in the file says why not;
 * - every service but postgres and redis runs on a read-only root filesystem
 *   with an in-memory /tmp, and every long-running service has memory (and,
 *   where sized, CPU) limits (#1270);
 * - redis is capped below its memory limit and never evicts stream data;
 * - the api and workers reach Postgres through the least-privilege login;
 * - the api receives the Discord credentials;
 * - every third-party base image is pinned by digest.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const COMPOSE_FILES = ['docker/compose.yml', 'docker/compose.stand.yml'] as const;
const read = (relativePath: string) => readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');

function services(yaml: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let inServices = false;
  let current: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current) blocks.set(current, body.join('\n'));
  };
  for (const line of yaml.split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line)) break;
    const match = /^ {2}([\w-]+):\s*$/.exec(line);
    if (match?.[1]) {
      flush();
      current = match[1];
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return blocks;
}

function block(file: string, name: string): string {
  const body = services(read(file)).get(name);
  if (body === undefined) throw new Error(`service ${name} not found in ${file}`);
  return body;
}

/** Long-running panel services built from this repository (plus the proxy). */
function panelServices(file: string): string[] {
  return [...services(read(file)).keys()].filter(
    (name) =>
      name === 'caddy' ||
      name === 'migrator' ||
      name === 'api' ||
      name === 'web' ||
      name.startsWith('worker-'),
  );
}

describe('compose secrets (#1034, #1258)', () => {
  it('never falls back to a well-known restic password', () => {
    for (const file of COMPOSE_FILES) {
      expect(read(file)).not.toMatch(/RESTIC_PASSWORD:-[^}]/);
    }
  });

  it('docker/compose.yml refuses to start without the restic password', () => {
    expect(block('docker/compose.yml', 'backup')).toContain(
      'RESTIC_PASSWORD: ${RESTIC_PASSWORD:?RESTIC_PASSWORD_is_required}',
    );
  });

  for (const file of COMPOSE_FILES) {
    it(`${file} refuses to start with an empty database password, encryption key or session secret`, () => {
      expect(block(file, 'postgres')).toContain(
        'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD_is_required}',
      );
      const api = block(file, 'api');
      expect(api).toContain(
        'APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY:?APP_ENCRYPTION_KEY_is_required}',
      );
      expect(api).toContain('SESSION_SECRET: ${SESSION_SECRET:?SESSION_SECRET_is_required}');
    });
  }

  it('.env.example documents how to generate the restic password', () => {
    expect(read('.env.example')).toMatch(/Generate: openssl rand -hex 32\nRESTIC_PASSWORD=\n/);
  });
});

describe('stand persistence and backups (#1030)', () => {
  it('runs Redis with append-only persistence on both deployments', () => {
    expect(block('docker/compose.yml', 'redis')).toMatch(
      /^ {6}- redis-server\n {6}- --appendonly\n {6}- 'yes'$/m,
    );
    const stand = block('docker/compose.stand.yml', 'redis');
    expect(stand).not.toContain("'--appendonly', 'no'");
    expect(stand).toMatch(/^ {8}exec docker-entrypoint\.sh redis-server --appendonly yes /m);
  });

  it('caps Redis below its container limit and never evicts stream data (#1270)', () => {
    const base = block('docker/compose.yml', 'redis');
    expect(base).toMatch(
      /^ {6}- --maxmemory\n {6}- 768mb\n {6}- --maxmemory-policy\n {6}- noeviction$/m,
    );
    // The stand keeps requirepass, the rnsquadjs ACL user and AOF on the same command.
    const stand = block('docker/compose.stand.yml', 'redis');
    expect(stand).toMatch(
      /exec docker-entrypoint\.sh redis-server --appendonly yes --save 60 1 \\\n {10}--maxmemory 768mb --maxmemory-policy noeviction \\\n {10}--requirepass /,
    );
    expect(stand).toContain('--user rnsquadjs on');
  });

  it("converts the stand's existing RDB into the AOF once instead of starting empty", () => {
    // Redis started with --appendonly yes ignores dump.rdb; without this step
    // the switch would drop every stream, consumer group and cached session.
    const stand = block('docker/compose.stand.yml', 'redis');
    expect(stand).toContain('if [ ! -d /data/appendonlydir ] && [ -f /data/dump.rdb ]; then');
    expect(stand).toContain('redis-cli config set appendonly yes');
  });

  it('defines the same backup service on the stand as in docker/compose.yml', () => {
    const base = block('docker/compose.yml', 'backup');
    const stand = block('docker/compose.stand.yml', 'backup');
    for (const line of [
      "profiles: ['backup']",
      'dockerfile: docker/restic.Dockerfile',
      'RESTIC_BACKUP_SOURCES: /data',
      '- backup_dump:/data',
      '- backup_repo:/backup',
    ]) {
      expect(base).toContain(line);
      expect(stand).toContain(line);
    }
    const preCommands = (body: string) =>
      body.slice(body.indexOf('PRE_COMMANDS'), body.indexOf('    volumes:'));
    expect(preCommands(stand)).toBe(preCommands(base));
    // A host-built short name must never resolve to somebody's Docker Hub image.
    expect(stand).toContain('pull_policy: never');
  });

  it('binds the stand backup staging tree under DATA_DIR, where the bridge and restore.sh look', () => {
    const stand = read('docker/compose.stand.yml');
    expect(stand).toMatch(
      /\n {2}backup_dump:\n(?: {4}.*\n)*? {6}device: \$\{DATA_DIR\}\/backup-dump/,
    );
  });
});

describe('container hardening (#1268)', () => {
  for (const file of COMPOSE_FILES) {
    const yaml = read(file);

    it(`${file} defines the hardening fragment`, () => {
      expect(yaml).toMatch(
        /\nx-hardening: &hardening\n {2}cap_drop: \['ALL'\]\n {2}security_opt: \['no-new-privileges:true'\]\n/,
      );
    });

    it(`${file}: the hardening fragment makes the root filesystem read-only with an in-memory /tmp (#1270)`, () => {
      const fragment =
        /\nx-hardening: &hardening\n((?: {2}.*\n|\n| *#.*\n)*?)\n/.exec(yaml)?.[1] ?? '';
      expect(fragment).toMatch(/^ {2}read_only: true$/m);
      expect(fragment).toMatch(/^ {2}tmpfs: \['\/tmp'\]$/m);
    });

    it(`${file}: the worker limits fragment is 512m and 1 CPU (#1270)`, () => {
      expect(yaml).toMatch(
        /\nx-worker-limits: &worker-limits\n {2}mem_limit: 512m\n {2}cpus: 1\.0\n/,
      );
    });

    it(`${file}: every service except postgres and redis runs with read_only: true (#1270)`, () => {
      const hardened = /^ {4}<<: (?:\*hardening|\[\*hardening, \*worker-limits\])$/m;
      const writable = [...services(yaml)]
        .filter(([, body]) => !hardened.test(body) && !/^ {4}read_only: true$/m.test(body))
        .map(([name]) => name)
        .sort();
      // The remaining services are either stateful (postgres, redis write
      // their own data directories), profile-only tools (backup runs restic
      // against host volumes) or one-shot image builders that run /bin/true.
      expect(writable).toEqual([
        'backup',
        'depot-init-image',
        'postgres',
        'redis',
        'rnsquadjs-image',
        'squad-server-image',
      ]);
    });

    it(`${file}: limits memory of every long-running service (#1270)`, () => {
      const limits: Record<string, string> = {
        api: '1g',
        web: '1g',
        caddy: '256m',
        postgres: '4g',
        redis: '1g',
      };
      for (const [name, limit] of Object.entries(limits)) {
        expect(block(file, name), name).toMatch(new RegExp(`^ {4}mem_limit: ${limit}$`, 'm'));
      }
      for (const name of ['api', 'web']) {
        expect(block(file, name), name).toMatch(/^ {4}cpus: 2\.0$/m);
      }
      for (const name of panelServices(file).filter((n) => n.startsWith('worker-'))) {
        expect(block(file, name), name).toMatch(/^ {4}<<: \[\*hardening, \*worker-limits\]$/m);
      }
    });

    it(`${file}: web keeps its Next.js cache writable, owned by the node user (#1270)`, () => {
      expect(block(file, 'web')).toContain('      - /app/apps/web/.next/cache:uid=1000,gid=1000');
    });

    for (const name of panelServices(file)) {
      it(`${file}: ${name} drops all capabilities and cannot gain privileges`, () => {
        expect(block(file, name)).toMatch(
          /^ {4}<<: (?:\*hardening|\[\*hardening, \*worker-limits\])$/m,
        );
      });
    }

    for (const name of ['postgres', 'redis', 'backup']) {
      it(`${file}: ${name} cannot gain privileges through setuid binaries`, () => {
        expect(block(file, name)).toContain("security_opt: ['no-new-privileges:true']");
      });
    }

    it(`${file}: adds back only the capabilities a service needs`, () => {
      const added = [...services(yaml)]
        .filter(([, body]) => body.includes('cap_add:'))
        .map(([name, body]) => `${name}=${/cap_add: (.*)/.exec(body)?.[1]}`);
      expect(added.sort()).toEqual(["api=['CHOWN']", "caddy=['NET_BIND_SERVICE']"]);
    });

    it(`${file}: only the api and the two host-file workers run as uid 0`, () => {
      const root = [...services(yaml)]
        .filter(([, body]) => /^ {4}user: ["']0:/m.test(body))
        .map(([name]) => name)
        .sort();
      expect(root).toEqual(['api', 'worker-diag-flush', 'worker-media-publisher']);
    });

    it(`${file}: bridge-consuming workers keep the panel GID as a non-root user`, () => {
      for (const name of [
        'worker-log-ingest',
        'worker-config-sync',
        'worker-scheduler',
        'worker-metrics-sampler',
      ]) {
        expect(block(file, name)).toContain('user: "1000:${PANEL_GID:-987}"');
      }
    });
  }

  for (const dockerfile of [
    'docker/web.Dockerfile',
    'docker/api.Dockerfile',
    'docker/worker.Dockerfile',
  ]) {
    it(`${dockerfile} runs its runtime stage as the unprivileged node user`, () => {
      const source = read(dockerfile);
      const runtime = source.slice(source.lastIndexOf('\nFROM '));
      expect(runtime).toMatch(/\nUSER node\n/);
    });
  }

  it("web starts next directly, not through corepack (whose pnpm lives in root's home)", () => {
    expect(read('docker/web.Dockerfile')).toContain(
      'CMD ["node_modules/.bin/next", "start", "--port", "3000"]',
    );
  });
});

describe('least-privilege database login (#1250)', () => {
  const APP_URL = 'postgres://${PANEL_DB_USER:-admin}:${PANEL_DB_PASSWORD:-${POSTGRES_PASSWORD}}@';
  const OWNER_URL = 'postgres://admin:${POSTGRES_PASSWORD}@';

  for (const file of COMPOSE_FILES) {
    it(`${file}: the api and workers connect through PANEL_DB_USER, only DDL runners as the owner`, () => {
      const owners: string[] = [];
      for (const [name, body] of services(read(file))) {
        const url = /DATABASE_URL: (\S+)/.exec(body)?.[1];
        if (!url) continue;
        if (url.startsWith(OWNER_URL)) owners.push(name);
        else expect(url.startsWith(APP_URL), `${name}: ${url}`).toBe(true);
      }
      expect(owners.sort()).toEqual(['migrator', 'worker-event-partition']);
    });

    it(`${file}: the migrator receives the role it provisions`, () => {
      const migrator = block(file, 'migrator');
      expect(migrator).toContain('PANEL_DB_USER: ${PANEL_DB_USER:-}');
      expect(migrator).toContain('PANEL_DB_PASSWORD: ${PANEL_DB_PASSWORD:-}');
    });
  }

  it('.env.example documents the application login', () => {
    const example = read('.env.example');
    expect(example).toMatch(/\nPANEL_DB_USER=\n/);
    expect(example).toMatch(/\nPANEL_DB_PASSWORD=\n/);
  });
});

describe('Discord credentials reach the api (#1318)', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: passes DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_PUBLIC_KEY`, () => {
      const api = block(file, 'api');
      for (const key of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_PUBLIC_KEY']) {
        expect(api).toContain(`${key}: \${${key}:-}`);
      }
    });
  }

  it('.env.example documents DISCORD_PUBLIC_KEY', () => {
    expect(read('.env.example')).toMatch(/\nDISCORD_PUBLIC_KEY=\n/);
  });
});

describe('pinned base images (#1276)', () => {
  const DIGEST = /@sha256:[0-9a-f]{64}$/;

  it('pins every third-party compose image by digest', () => {
    for (const file of COMPOSE_FILES) {
      for (const [name, body] of services(read(file))) {
        const image = /^ {4}image: (\S+)$/m.exec(body)?.[1];
        // Images built here (squad-panel/*, squad-server) or injected by digest
        // through the release env are not third-party pulls.
        if (!image || image.startsWith('${') || /^squad-(panel\/|server:)/.test(image)) continue;
        expect(image, `${file}: ${name}`).toMatch(DIGEST);
      }
    }
  });

  it('pins every Dockerfile base image by digest', () => {
    for (const dockerfile of [
      'api',
      'caddy-duckdns',
      'depot-init',
      'restic',
      'rnsquadjs',
      'squad-server',
      'web',
      'worker',
    ]) {
      const source = read(`docker/${dockerfile}.Dockerfile`);
      const stages = new Set([...source.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((m) => m[1]));
      for (const [, image] of source.matchAll(/^FROM (\S+)/gm)) {
        if (image && stages.has(image)) continue;
        expect(image, `docker/${dockerfile}.Dockerfile`).toMatch(DIGEST);
      }
    }
  });

  it('builds Caddy with a released DuckDNS module, not whatever HEAD is', () => {
    expect(read('docker/caddy-duckdns.Dockerfile')).toMatch(
      /xcaddy build --with github\.com\/caddy-dns\/duckdns@v\d+\.\d+\.\d+\n/,
    );
  });

  it('lets Dependabot propose digest updates for Dockerfiles and compose files', () => {
    const dependabot = read('.github/dependabot.yml');
    expect(dependabot).toMatch(/package-ecosystem: "docker"\n {4}directory: "\/docker"/);
    expect(dependabot).toMatch(/package-ecosystem: "docker-compose"\n {4}directory: "\/docker"/);
  });
});
