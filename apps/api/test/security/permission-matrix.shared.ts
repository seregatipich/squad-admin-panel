// The database-backed half of the permission matrix: one integration app, one
// API token per probed permission set, and the per-route sweep. The
// permission-matrix.part-N.test.ts files each call registerPermissionSweep()
// for their own slice of the route table (see permission-matrix.routes.ts).
import * as schema from '@squad/db/schema';
import { playerApiTokens } from '@squad/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { InjectOptions } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintApiToken } from '../../src/lib/api-tokens.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from '../integration/harness.js';
import { ALL_PERM_KEYS, protectedRoutes, routesForPart } from './permission-matrix.routes.js';

const OWNER_STEAM = testSteamId(700001);

function canonicalUrl(url: string): string {
  return url.replace(/:([a-zA-Z_]+)/g, (_m, name: string) => {
    if (name === 'id') return '00000000-0000-0000-0000-000000000001';
    if (name === 'playerId') return '00000000-0000-0000-0000-000000000002';
    if (name === 'filename') return 'Server.cfg';
    if (name === 'versionId') return '00000000-0000-0000-0000-000000000001';
    return 'placeholder';
  });
}

let h: IntegrationHarness;
let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Request headers that authenticate each matrix user (session cookie or API token). */
const authHeaders = new Map<string, Record<string, string>>();
/**
 * Holds exactly `perms`: an API token of the all-powerful seeded Owner narrowed
 * to `perms` (`role ∩ scopes`, `narrowToTokenScopes`). A session-based user
 * cannot do this: a role without `panel_access` is dropped to anonymous (#33)
 * and, with `panel_access`, derives far more than the set; flag-gated keys
 * additionally need role flags that the DB ties to `panel_access` (#36).
 */
async function createTokenUserWithPerms(key: string, perms: string[]): Promise<void> {
  const ownerPlayerId = h.seed.ownerPlayerId;
  if (!ownerPlayerId) throw new Error('matrix needs the seeded owner');
  const minted = mintApiToken();
  await db.insert(playerApiTokens).values({
    id: minted.id,
    playerId: ownerPlayerId,
    name: `matrix-${key}`,
    tokenHash: minted.tokenHash,
    scopes: perms,
  });
  authHeaders.set(key, { authorization: `Bearer ${minted.plaintext}` });
}

async function inject(
  method: string,
  url: string,
  cookieKey: string,
): Promise<{ statusCode: number }> {
  const headers = authHeaders.get(cookieKey);
  if (!headers) throw new Error(`no credentials for key "${cookieKey}"`);
  // Methods come from the registered route table, so they are valid HTTP methods.
  return h.app.inject({ method: method as InjectOptions['method'], url, headers });
}

/**
 * Registers the `permission matrix` suite for one slice of the protected
 * routes. It builds the integration app once in `beforeAll`, creates a token
 * user for the empty set, for every permission key alone and for every unique
 * required-permission set of the WHOLE route table (so every part probes with
 * the same credentials the single-file sweep used), then sweeps each route of
 * the slice: 403 with no permissions, not-403 with the full required set, and
 * one probe per permission key.
 *
 * Call it once per test file, at the top level.
 *
 * @param part - 1-based slice number, see `routesForPart`.
 * @throws If `part` is outside `1..PERMISSION_MATRIX_PART_COUNT`.
 */
export function registerPermissionSweep(part: number): void {
  const sweptRoutes = routesForPart(protectedRoutes, part);

  describe('permission matrix', () => {
    beforeAll(async () => {
      h = await buildIntegrationApp({
        seedOwner: { steamId64: OWNER_STEAM },
        bridge: makeFakeBridge(),
      });

      sql = postgres(h.url, { max: 10, onnotice: () => undefined });
      db = drizzle(sql, { schema }) as unknown as ReturnType<typeof drizzle<typeof schema>>;

      const uniqueRequiredSets = new Set(
        protectedRoutes.map((r) => r.required.slice().sort().join(',')),
      );

      const tasks: Array<[string, string[]]> = [
        ['noPerms', []],
        ...ALL_PERM_KEYS.map((perm): [string, string[]] => [perm, [perm]]),
        ...[...uniqueRequiredSets].map((setKey): [string, string[]] => [
          `full:${setKey}`,
          setKey.split(',').filter(Boolean),
        ]),
      ];

      await Promise.all(tasks.map(([key, perms]) => createTokenUserWithPerms(key, perms)));
    });

    afterAll(async () => {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await h.cleanup();
    }, 60_000);

    for (const route of sweptRoutes) {
      const { method, url, required } = route;
      const targetUrl = canonicalUrl(url);
      const label = `${method} ${url}`;
      const fullKey = `full:${required.slice().sort().join(',')}`;

      describe(label, () => {
        it('returns 403 to a user with no permissions', async () => {
          const res = await inject(method, targetUrl, 'noPerms');
          expect(res.statusCode).toBe(403);
        });

        it('returns not-403 to a user with all required permissions', async () => {
          const res = await inject(method, targetUrl, fullKey);
          expect(res.statusCode).not.toBe(403);
        });

        for (const perm of ALL_PERM_KEYS) {
          const isExact = required.length === 1 && required[0] === perm;
          const isPartialMatch = required.includes(perm) && required.length > 1;

          it(`with only ${perm}: ${isExact ? 'allowed' : '403'}`, async () => {
            const res = await inject(method, targetUrl, perm);
            if (isExact) {
              expect(res.statusCode).not.toBe(403);
            } else if (isPartialMatch) {
              expect(res.statusCode).toBe(403);
            } else {
              expect(res.statusCode).toBe(403);
            }
          });
        }
      });
    }
  });
}
