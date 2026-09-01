// regression: first-owner.test.ts beforeEach stripped Owner role from real users
// Fix: snapshot/mask/restore helper in test/helpers/snapshot-restore.ts
import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

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
});
