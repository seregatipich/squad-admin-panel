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
const EXPECTED_DRIZZLE_WRITERS: Record<string, number> = {
  'apps/api/src/lib/first-owner.ts': 1,
  'apps/api/src/routes/integrations-vip.ts': 2,
  'apps/api/src/routes/players.ts': 2,
  'apps/api/src/routes/role-members.ts': 5,
  'apps/api/src/routes/roles.ts': 1,
  'apps/api/src/routes/whitelist-applications.ts': 1,
  'apps/api/src/routes/whitelist.ts': 3,
  'apps/workers/role-expirer/src/tick.ts': 1,
  'apps/workers/seed-reward/src/tick.ts': 1,
  'packages/db/src/economy/vip-grant.ts': 1,
};

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const absolute = path.join(root, name);
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return absolute.endsWith('.ts') ? [absolute] : [];
  });
}

interface DrizzleRoleWriter {
  relative: string;
  statement: string;
  resultContext: string;
}

function drizzleRoleWriters(): DrizzleRoleWriter[] {
  const writers: DrizzleRoleWriter[] = [];
  const roots = ['apps', 'packages'].map((directory) => path.join(REPO_ROOT, directory));
  for (const file of roots
    .flatMap(sourceFiles)
    .filter((candidate) => candidate.includes('/src/') && !candidate.includes('/node_modules/'))) {
    const source = readFileSync(file, 'utf8');
    let cursor = 0;
    while (cursor < source.length) {
      const updateAt = source.indexOf('.update(players)', cursor);
      if (updateAt === -1) break;
      const statementEnd = source.indexOf(';', updateAt);
      if (statementEnd === -1) break;
      const statement = source.slice(updateAt, statementEnd + 1);
      if (ROLE_FIELD.test(statement)) {
        writers.push({
          relative: path.relative(REPO_ROOT, file),
          statement,
          resultContext: source.slice(statementEnd + 1, statementEnd + 700),
        });
      }
      cursor = statementEnd + 1;
    }
  }
  return writers;
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

  it('keeps integrations-vip as the sole writer of a non-null lifecycle marker', () => {
    expect(
      drizzleRoleWriters()
        .filter((writer) => {
          const value = writer.statement.match(/roleLifecycleEventId:\s*([^,}\n]+)/)?.[1]?.trim();
          return value !== undefined && value !== 'null';
        })
        .map((writer) => writer.relative),
    ).toEqual(['apps/api/src/routes/integrations-vip.ts']);
    for (const relative of [
      'packages/db/src/seed-demo.ts',
      'apps/api/src/tools/mint-owner-session.ts',
    ]) {
      expect(readFileSync(path.join(REPO_ROOT, relative), 'utf8'), relative).toMatch(
        /role_lifecycle_event_id\s*=\s*NULL/,
      );
    }
  });

  it('enumerates every role writer and fences every non-lifecycle update with checked CAS', () => {
    const writers = drizzleRoleWriters();
    const counts = Object.fromEntries(
      Object.keys(EXPECTED_DRIZZLE_WRITERS).map((relative) => [
        relative,
        writers.filter((writer) => writer.relative === relative).length,
      ]),
    );
    expect(counts).toEqual(EXPECTED_DRIZZLE_WRITERS);
    expect(writers.map((writer) => writer.relative).sort()).toEqual(
      Object.entries(EXPECTED_DRIZZLE_WRITERS)
        .flatMap(([relative, count]) => Array.from({ length: count }, () => relative))
        .sort(),
    );

    for (const writer of writers) {
      if (writer.relative === 'apps/api/src/routes/integrations-vip.ts') continue;

      if (writer.relative === 'apps/workers/role-expirer/src/tick.ts') {
        expect(writer.statement).toContain('eq(players.roleId, assignment.roleId)');
        expect(writer.statement).toContain('eq(players.roleExpiresAt, assignment.roleExpiresAt)');
        expect(writer.statement).toContain('isNull(players.roleLifecycleEventId)');
      } else {
        expect(writer.statement, writer.relative).toContain('isNull(players.roleLifecycleEventId)');
      }
      expect(writer.statement, writer.relative).toContain('.returning(');
      expect(writer.resultContext, `${writer.relative}: unchecked RETURNING`).toMatch(
        /\bif\s*\(\s*!?updated\b/,
      );
    }

    for (const relative of [
      'packages/db/src/seed-demo.ts',
      'apps/api/src/tools/mint-owner-session.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(source, relative).toMatch(
        /ON CONFLICT \(steam_id64\) DO UPDATE SET[\s\S]*?WHERE players\.role_lifecycle_event_id IS NULL[\s\S]*?RETURNING id/,
      );
      expect(source, `${relative}: unchecked RETURNING`).toMatch(
        /(?:adminRows\[0\]|if \(!player\))/,
      );
    }
  });
});
