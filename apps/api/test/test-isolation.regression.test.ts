// regression: first-owner.test.ts beforeEach stripped Owner role from real users
// Fix: snapshot/mask/restore helper in test/helpers/snapshot-restore.ts
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function testFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const absolute = path.join(root, name);
    if (statSync(absolute).isDirectory()) return testFiles(absolute);
    return absolute.endsWith('.ts') ? [absolute] : [];
  });
}

function unscopedMultilineRoleUpdates(source: string): number[] {
  const lines: number[] = [];
  const update = /\.update\(players\)([\s\S]{0,1200}?)\.where\(([\s\S]{0,600}?)\);/g;
  for (const match of source.matchAll(update)) {
    const statement = match[0];
    const where = match[2] ?? '';
    if (
      /\b(?:roleId|roleExpiresAt|roleComment)\s*:/.test(statement) &&
      !/players\.steamId64/.test(where)
    ) {
      lines.push(source.slice(0, match.index).split('\n').length);
    }
  }
  return lines;
}

describe('test isolation', () => {
  it('no test mutates players/roles/panel_meta without test-id filter', () => {
    const out = execSync(
      `grep -rn "delete(players)\\|update(players).*roleId\\|update(panelMeta)\\|delete(roles)" apps/api/test/ \
       | grep -v \
           -e "steamId64.*TEST_PLAYER" \
           -e "steamId64.*testSteamId" \
           -e "steamId64, sid" \
           -e "steamId64, steamId)" \
           -e "test-isolation" \
           -e "snapshot-restore" \
           -e "e2e/" \
           -e "roles\\.id, id)" \
           -e "security/sql-injection" \
           -e "security/permission-matrix" \
           -e "security/xss-smoke" \
       || true`,
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    if (out.trim()) {
      throw new Error(
        'Found unguarded mutations of shared DB state in tests:\n' +
          out +
          '\n\n' +
          'Use testSteamId(N) helpers from test/helpers/snapshot-restore.ts ' +
          'or filter by TEST_PLAYER_* constants. See ' +
          'docs/development/testing.md "Test isolation" for the pattern.',
      );
    }
  });

  it('does not let multiline player role updates evade the SteamID64 scope guard', () => {
    expect(
      unscopedMultilineRoleUpdates(`db
        .update(players)
        .set({ roleId: roleId })
        .where(eq(players.id, playerId));`),
    ).toEqual([2]);

    const offenders = testFiles(path.join(REPO_ROOT, 'apps/api/test'))
      .filter(
        (file) =>
          !file.includes('/e2e/') &&
          !file.includes('/security/') &&
          !file.endsWith('/test-isolation.regression.test.ts') &&
          !file.endsWith('/helpers/snapshot-restore.ts'),
      )
      .flatMap((file) =>
        unscopedMultilineRoleUpdates(readFileSync(file, 'utf8')).map(
          (line) => `${path.relative(REPO_ROOT, file)}:${line}`,
        ),
      );

    expect(offenders).toEqual([]);
  });
});
