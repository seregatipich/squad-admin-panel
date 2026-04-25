import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'server:create',
  'server:edit',
  'server:config:write',
  'server:config:history',
  'player:view_eos_id',
  'player:view_steam_id',
  'user:create',
  'user:edit',
  'user:delete',
  'role:manage',
  'permission:manage',
  'host:bridge_control',
  'org:view',
  'org:edit',
];

const root = path.resolve(import.meta.dirname, '../../..');

describe('permission key renames', () => {
  for (const key of FORBIDDEN) {
    it(`no remaining references to "${key}"`, () => {
      const result = execSync(
        `grep -rn -F "'${key}'" apps/api/src/ apps/web/src/ packages/shared-config/src/ 2>/dev/null || true`,
        { encoding: 'utf8', cwd: root },
      );
      expect(result.trim(), `stale references to ${key}:\n${result}`).toBe('');
    });
  }
});
