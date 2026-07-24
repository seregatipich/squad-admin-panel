import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guard against silent drift of the INFRA-8 backup service: it must
// keep backing up the LOGICAL dumps (pg_dump + redis-cli --rdb) rather than the
// raw data directories. No YAML parser is a dependency here, so we assert on the
// text of the `backup` service block, sliced out of docker-compose.yml.

const composePath = path.resolve(import.meta.dirname, '../../../../docker-compose.yml');
const compose = readFileSync(composePath, 'utf8');

function serviceBlock(name: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`service ${name} not found in docker-compose.yml`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    // Next top-level key (`volumes:`) or next 2-space-indented service key.
    if (/^\S/.test(l) || /^ {2}\S/.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('docker-compose backup service (INFRA-8)', () => {
  const block = serviceBlock('backup');

  it('is gated behind the `backup` profile', () => {
    expect(block).toContain("profiles: ['backup']");
  });

  it('builds the custom restic image (pg_dump/redis-cli tooling)', () => {
    expect(block).toContain('dockerfile: docker/restic.Dockerfile');
    expect(block).toContain('image: squad-panel/restic:latest');
  });

  it('dumps Postgres and Redis via PRE_COMMANDS', () => {
    expect(block).toContain('PRE_COMMANDS');
    expect(block).toMatch(/pg_dump[^\n]*-Fc[^\n]*\/data\/postgres\/admin\.dump/);
    expect(block).toMatch(/redis-cli[^\n]*--rdb[^\n]*\/data\/redis\/dump\.rdb/);
  });

  it('backs up the dump staging dir, not the raw data volumes', () => {
    expect(block).toContain('RESTIC_BACKUP_SOURCES: /data');
    expect(block).toContain('backup_dump:/data');
    expect(block).not.toContain('postgres_data');
    expect(block).not.toContain('redis_data');
  });

  it('waits for postgres and redis to be healthy', () => {
    expect(block).toMatch(/postgres:\s*\n\s*condition: service_healthy/);
    expect(block).toMatch(/redis:\s*\n\s*condition: service_healthy/);
  });
});
