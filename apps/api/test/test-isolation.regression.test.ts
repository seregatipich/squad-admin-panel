import { execSync } from 'node:child_process';
import { describe, it } from 'vitest';

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
           -e "auth-steam\\.test\\.ts" \
           -e "security/sql-injection" \
           -e "security/permission-matrix" \
           -e "security/xss-smoke" \
       || true`,
      { encoding: 'utf8', cwd: '/home/squad/squad-admin-panel' },
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
