import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ROLE_PROJECTION_FIELDS = [
  'roleId',
  'roleExpiresAt',
  'roleComment',
  'roleLifecycleEventId',
] as const;
const ROLE_FIELD = /\b(?:roleId|roleExpiresAt|roleComment|roleLifecycleEventId)\b\s*(?::|[,}])/;

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const absolute = path.join(root, name);
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return absolute.endsWith('.ts') ? [absolute] : [];
  });
}

describe('VIP lifecycle role ownership marker', () => {
  it('writes a complete projection in every production Drizzle role writer', () => {
    const offenders: string[] = [];
    const roots = ['apps', 'packages'].map((directory) => path.join(REPO_ROOT, directory));
    const update = /\.update\(players\)([\s\S]{0,2500}?)\.where\(/g;

    for (const file of roots
      .flatMap(sourceFiles)
      .filter((file) => file.includes('/src/') && !file.includes('/node_modules/'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(update)) {
        const statement = match[1] ?? '';
        if (!ROLE_FIELD.test(statement)) continue;
        const missing = ROLE_PROJECTION_FIELDS.filter(
          (field) => !new RegExp(`\\b${field}\\b\\s*(?::|[,}])`).test(statement),
        );
        if (missing.length > 0) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: missing ${missing.join(', ')}`);
        }
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it('writes a complete projection in the two production raw-SQL role writers', () => {
    for (const relative of [
      'packages/db/src/seed-demo.ts',
      'apps/api/src/tools/mint-owner-session.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      for (const field of [
        'role_id',
        'role_expires_at',
        'role_comment',
        'role_lifecycle_event_id',
      ]) {
        expect(source, `${relative}: missing ${field}`).toContain(field);
      }
    }
  });
});
