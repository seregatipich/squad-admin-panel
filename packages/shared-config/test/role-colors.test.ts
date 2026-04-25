import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_COLORS } from '../src/role-colors.js';

describe('ROLE_COLORS', () => {
  it('palette stays in sync with SQL CHECK constraint in 0009 migration', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../../packages/db/drizzle/0009_panel_rbac.sql'),
      'utf8',
    );
    const checkMatch = sql.match(/CONSTRAINT roles_color_palette CHECK \(\s*color IN \(([^)]+)\)/);
    expect(checkMatch, 'CHECK constraint not found in migration').toBeTruthy();
    const sqlColors = (checkMatch?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    expect([...ROLE_COLORS].sort()).toEqual([...sqlColors].sort());
  });

  it('has exactly 16 colors', () => {
    expect(ROLE_COLORS.length).toBe(16);
  });

  it('all entries are unique', () => {
    expect(new Set(ROLE_COLORS).size).toBe(ROLE_COLORS.length);
  });
});
