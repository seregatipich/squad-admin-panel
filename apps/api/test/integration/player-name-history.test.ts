import { playerNameHistory, players } from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(182000);
const GHOST_STEAM = testSteamId(182001);
const CYRILLIC_STEAM = testSteamId(182002);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

interface PlayerListItem {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
}

interface PlayerListBody {
  items: PlayerListItem[];
  total: number;
}

interface PlayerDetailBody {
  player: { id: string };
  names: Array<{ name: string; name_normalized: string }>;
}

let h: IntegrationHarness;
let ownerCookie: string;
let ghostId: string;
let cyrillicId: string;

async function seedPlayer(
  steamId64: bigint,
  canonicalName: string,
  historyNames: string[],
): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName,
      canonicalNameNormalized: normalizePlayerName(canonicalName),
    })
    .returning({ id: players.id });
  if (!row) throw new Error('failed to seed player');
  for (const name of historyNames) {
    await h.db.insert(playerNameHistory).values({
      playerId: row.id,
      name,
      nameNormalized: normalizePlayerName(name),
    });
  }
  return row.id;
}

async function search(query: string): Promise<PlayerListBody> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/players?q=${encodeURIComponent(query)}`,
    headers: { cookie: ownerCookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as PlayerListBody;
}

describeIfDb('player name history search', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'NameHistoryOwner' },
    });
    ownerCookie = await loginAsOwner(h);
    ghostId = await seedPlayer(GHOST_STEAM, 'Ghost', ['Ghost', '[MDC] GhostSniper']);
    cyrillicId = await seedPlayer(CYRILLIC_STEAM, 'Шyxer', ['✪ Mdc︱ Шyxer']);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('finds a player by a historic nickname whose clan tag was stripped', async () => {
    const body = await search('GhostSniper');
    expect(body.items.map((item) => item.id)).toContain(ghostId);
  });

  it('finds the same player when the query itself carries the clan tag', async () => {
    const body = await search('[MDC] GhostSniper');
    expect(body.items.map((item) => item.id)).toContain(ghostId);
  });

  it('finds a player by the unicode base name of a decorated historic nickname', async () => {
    const body = await search('Шyxer');
    expect(body.items.map((item) => item.id)).toContain(cyrillicId);
  });

  it('does not match unrelated players', async () => {
    const body = await search('NoSuchPlayerXyz');
    expect(body.items.map((item) => item.id)).not.toContain(ghostId);
    expect(body.items.map((item) => item.id)).not.toContain(cyrillicId);
  });

  it('exposes name history with normalized values on the detail endpoint', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${ghostId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PlayerDetailBody;
    const historic = body.names.find((entry) => entry.name === '[MDC] GhostSniper');
    expect(historic).toBeDefined();
    expect(historic?.name_normalized).toBe('ghostsniper');
  });
});
