// #1239: the live container log carries the same lines as SquadGame.log,
// player IPs included, so it needs `server:download_logs` like the log-file
// routes — `server:view` alone must not open it.
import { playerApiTokens } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintApiToken } from '../../src/lib/api-tokens.js';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness } from './harness.js';

const OWNER_STEAM_ID = testSteamId(942501);

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

async function tokenHeader(scopes: string[]): Promise<string> {
  const ownerId = h.seed.ownerPlayerId!;
  const minted = mintApiToken();
  await h.db.insert(playerApiTokens).values({
    id: minted.id,
    playerId: ownerId,
    name: `logs-${minted.id.slice(0, 8)}`,
    tokenHash: minted.tokenHash,
    scopes,
  });
  invalidatePermissionCache(ownerId);
  return `Bearer ${minted.plaintext}`;
}

describe('GET /api/v1/servers/:id/logs/ws permission', () => {
  it('refuses a server:view-only token with 403 before any upgrade', async () => {
    const authorization = await tokenHeader(['server:view']);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/logs/ws`,
      headers: { authorization },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('lets a server:download_logs token past the permission gate', async () => {
    const authorization = await tokenHeader(['server:download_logs']);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/logs/ws`,
      headers: { authorization },
    });
    expect(res.statusCode, res.body).not.toBe(403);
  });
});
