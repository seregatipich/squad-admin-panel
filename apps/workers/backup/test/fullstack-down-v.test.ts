import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Contract guard for the INFRA-8-P1 full-stack disaster-recovery script
// (scripts/test-fullstack-down-v.sh). The script itself is run-deferred (it
// destroys the local stack and exceeds the CI runner — see #219), so it cannot
// execute here; instead we assert on its source so a regression that guts the
// destroy→restore→assert sequence or drops the fail-closed guard is caught.

const scriptPath = path.resolve(
  import.meta.dirname,
  '../../../../scripts/test-fullstack-down-v.sh',
);
const script = readFileSync(scriptPath, 'utf8');

describe('scripts/test-fullstack-down-v.sh (INFRA-8-P1)', () => {
  it('is fail-closed behind an explicit opt-in (never a silent/fake pass)', () => {
    expect(script).toContain('RUN_FULLSTACK_DOWN_V');
    // The guard exits non-zero without the opt-in rather than skipping green.
    expect(script).toMatch(/RUN_FULLSTACK_DOWN_V:-0.*!=.*"1"[\s\S]*?exit 2/);
  });

  it('performs the literal docker compose down -v volume destruction', () => {
    expect(script).toMatch(/docker compose --profile backup\)/);
    expect(script).toContain('down -v');
    // And wipes the bind-backed postgres/redis trees so the loss is real.
    expect(script).toMatch(/rm -rf "\$\{DATA_DIR:\?\}\/postgres"/);
    expect(script).toMatch(/rm -rf .*"\$\{DATA_DIR:\?\}\/redis"/);
  });

  it('restores via scripts/restore.sh --apply', () => {
    expect(script).toContain('scripts/restore.sh --apply');
  });

  it('asserts the panel is operational (api /health) and the seeded data survived', () => {
    expect(script).toContain('http://localhost:3000/health');
    expect(script).toMatch(/SELECT note FROM \$\{CANARY_TABLE\}/);
    expect(script).toContain('redis-cli get "$REDIS_KEY"');
  });

  it('forces a snapshot through the backup service before destroying volumes', () => {
    expect(script).toContain('run --rm backup backup');
  });
});

describe('scripts/restore.sh --snapshot support (INFRA-8-P1)', () => {
  const restorePath = path.resolve(import.meta.dirname, '../../../../scripts/restore.sh');
  const restore = readFileSync(restorePath, 'utf8');

  it('accepts a --snapshot id and validates it as a restic id or "latest"', () => {
    expect(restore).toMatch(/--snapshot\)/);
    expect(restore).toMatch(/\^\[a-f0-9\]\{8\}\(\[a-f0-9\]\{56\}\)\?\$/);
  });

  it('restores the selected snapshot (not hard-coded to latest)', () => {
    expect(restore).toContain('restic restore "$RESTORE_SNAPSHOT"');
    expect(restore).toContain('RESTORE_SNAPSHOT="$SNAPSHOT"');
  });
});
