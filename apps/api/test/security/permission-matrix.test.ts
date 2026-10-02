// Route-table canaries for the permission matrix. The database-backed sweep
// lives in permission-matrix.part-<n>.test.ts (see permission-matrix.shared.ts);
// nothing here touches Postgres.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_PERM_KEYS,
  PERMISSION_MATRIX_PART_COUNT,
  protectedRoutes,
  routesForPart,
  wsRoutes,
} from './permission-matrix.routes.js';

describe('permission matrix coverage', () => {
  it('includes Admins.cfg drift and force-sync routes', () => {
    expect(protectedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'GET',
          url: '/api/v1/admins-cfg/drift',
          required: ['admin_group:view'],
        }),
        expect.objectContaining({
          method: 'GET',
          url: '/api/v1/admins-cfg/drift/all',
          required: ['admin_group:view'],
        }),
        expect.objectContaining({
          method: 'POST',
          url: '/api/v1/admins-cfg/sync',
          required: ['admin_group:edit'],
        }),
      ]),
    );
  });

  it('sweeps POST /api/v1/servers/:id/update — server-update.ts was previously missing from collectProtectedRoutes() (#271)', () => {
    expect(protectedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          url: '/api/v1/servers/:id/update',
          required: ['server:update'],
        }),
      ]),
    );
  });

  it('tracks exactly the four currently-permissioned websocket routes (#250) — update deliberately if this list changes', () => {
    const sorted = wsRoutes
      .slice()
      .sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`));
    expect(sorted).toEqual([
      { method: 'GET', url: '/api/v1/depot/progress/ws', required: ['server:view'] },
      { method: 'GET', url: '/api/v1/servers/:id/install/ws', required: ['server:view'] },
      { method: 'GET', url: '/api/v1/servers/:id/logs/ws', required: ['server:download_logs'] },
      { method: 'GET', url: '/api/v1/ws/live', required: ['server:view'] },
    ]);
  });
});

describe('permission matrix sweep partition', () => {
  const parts = Array.from({ length: PERMISSION_MATRIX_PART_COUNT }, (_unused, index) => index + 1);
  // Each swept route registers two fixed cases plus one probe per permission key.
  const casesPerRoute = 2 + ALL_PERM_KEYS.length;

  it('assigns every protected route to exactly one part', () => {
    const swept = parts.flatMap((part) => routesForPart(protectedRoutes, part));

    expect(swept).toHaveLength(protectedRoutes.length);
    expect(new Set(swept).size).toBe(swept.length);
    expect(new Set(swept)).toEqual(new Set(protectedRoutes));
  });

  it('generates as many cases across the parts as the single-file sweep did', () => {
    const casesOfParts = parts.reduce(
      (total, part) => total + routesForPart(protectedRoutes, part).length * casesPerRoute,
      0,
    );

    expect(casesOfParts).toBe(protectedRoutes.length * casesPerRoute);
  });

  it('keeps the parts within one route of each other so the shards stay balanced', () => {
    const sizes = parts.map((part) => routesForPart(protectedRoutes, part).length);

    expect(Math.min(...sizes)).toBeGreaterThan(0);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('rejects a part outside the configured range', () => {
    expect(() => routesForPart(protectedRoutes, 0)).toThrow(/part must be an integer/);
    expect(() => routesForPart(protectedRoutes, PERMISSION_MATRIX_PART_COUNT + 1)).toThrow(
      /part must be an integer/,
    );
    expect(() => routesForPart(protectedRoutes, 1.5)).toThrow(/part must be an integer/);
  });

  it('has exactly one test file per part, each sweeping its own part', () => {
    const partFiles = readdirSync(import.meta.dirname)
      .filter((name) => /^permission-matrix\.part-\d+\.test\.ts$/.test(name))
      .sort();

    expect(partFiles).toEqual(parts.map((part) => `permission-matrix.part-${part}.test.ts`));
    for (const part of parts) {
      const source = readFileSync(
        new URL(`./permission-matrix.part-${part}.test.ts`, import.meta.url),
        'utf8',
      );
      expect(source).toMatch(new RegExp(`^registerPermissionSweep\\(${part}\\);$`, 'm'));
    }
  });
});
