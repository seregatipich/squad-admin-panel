import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test (#207): `apps/api/src/routes/index.ts` is the single place
 * route plugins are wired into the app (both `server.ts` and
 * `test/integration/harness.ts` call its exported `registerRoutes()`). Before
 * this file existed, `server.ts` and `harness.ts` each hand-maintained their
 * own ~115-entry import/registration list and silently drifted —
 * `auth-steam.ts` was registered in `server.ts` but missing from
 * `harness.ts`, so `GET /api/v1/auth/steam/login` 404'd in every integration
 * test. This test turns any future drift between `src/routes/` and
 * `routes/index.ts` into a hard failure instead of a silent gap.
 */

const ROUTES_DIR = resolve(__dirname, '../src/routes');
const ROUTES_INDEX = resolve(__dirname, '../src/routes/index.ts');
const INDEX_FILE_NAME = 'index.ts';

/** `.ts` route source files in `src/routes/`, excluding the barrel file itself. */
function routeFileNames(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith('.ts') && name !== INDEX_FILE_NAME)
    .sort();
}

function routesIndexSource(): string {
  return readFileSync(ROUTES_INDEX, 'utf-8');
}

/** Route file names imported by `routes/index.ts` (e.g. `admins-cfg.ts`). */
function importedRouteFileNames(): string[] {
  const source = routesIndexSource();
  const names: string[] = [];
  const importRe = /^import \w+ from '\.\/([\w-]+)\.js';$/gm;
  for (const match of source.matchAll(importRe)) {
    const name = match[1];
    if (name) names.push(`${name}.ts`);
  }
  return names.sort();
}

/** Default-import identifiers `routes/index.ts` imports from `./*.js`. */
function importedIdentifiers(): string[] {
  const source = routesIndexSource();
  const names: string[] = [];
  const importRe = /^import (\w+) from '\.\/[\w-]+\.js';$/gm;
  for (const match of source.matchAll(importRe)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names.sort();
}

/** Identifiers passed to `app.register(...)` inside `registerRoutes()`. */
function registeredIdentifiers(): string[] {
  const source = routesIndexSource();
  const bodyMatch =
    /export async function registerRoutes\([^)]*\): Promise<void> \{([\s\S]*)\n\}/.exec(source);
  const body = bodyMatch?.[1] ?? '';
  const names: string[] = [];
  const registerRe = /await app\.register\((\w+)\);/g;
  for (const match of body.matchAll(registerRe)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names.sort();
}

describe('route-registration-parity', () => {
  it('imports every route file present in src/routes/', () => {
    const filesOnDisk = routeFileNames();
    const filesImported = importedRouteFileNames();

    const missingFromIndex = filesOnDisk.filter((name) => !filesImported.includes(name));
    const extraInIndex = filesImported.filter((name) => !filesOnDisk.includes(name));

    expect(
      missingFromIndex,
      [
        `Route files present in src/routes/ but not imported by routes/index.ts: ${missingFromIndex.join(', ')}.`,
        'Add an import for each to apps/api/src/routes/index.ts and register it',
        'inside registerRoutes() — that is the single place routes are wired,',
        'so both server.ts and test/integration/harness.ts pick it up.',
      ].join('\n'),
    ).toEqual([]);

    expect(
      extraInIndex,
      `routes/index.ts imports route files that no longer exist in src/routes/: ${extraInIndex.join(', ')}. Remove the stale import.`,
    ).toEqual([]);
  });

  it('registers every route identifier it imports', () => {
    const imported = importedIdentifiers();
    const registered = registeredIdentifiers();

    const missingFromRegistration = imported.filter((name) => !registered.includes(name));
    const extraInRegistration = registered.filter((name) => !imported.includes(name));

    expect(
      missingFromRegistration,
      [
        `Route plugins imported by routes/index.ts but never passed to app.register() inside registerRoutes(): ${missingFromRegistration.join(', ')}.`,
        'A route that is imported but not registered is unreachable — add',
        '`await app.register(<identifier>);` to registerRoutes().',
      ].join('\n'),
    ).toEqual([]);

    expect(
      extraInRegistration,
      `registerRoutes() registers identifiers that routes/index.ts never imports: ${extraInRegistration.join(', ')}. Remove the stale registration.`,
    ).toEqual([]);
  });
});
