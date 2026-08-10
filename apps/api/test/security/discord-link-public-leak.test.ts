/**
 * DISCORD-4 (#151) regression guard: the Discord identity captured by the
 * OAuth link flow is panel-only data. It must never reach an unauthenticated
 * or federation-facing surface — `public-stats`, `public-clans`, or
 * `public-banlist`. The runtime half drives the real routes with a linked
 * player present; the static half fails the moment a `public-*` route module
 * starts selecting the link table at all.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  banlistPublicationSettings,
  clanMembers,
  clans,
  moderationActions,
  playerDiscordLinks,
  players,
} from '@squad/db/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from '../integration/harness.js';

const OWNER_STEAM = testSteamId(979101);
const LINKED_STEAM = testSteamId(979102);
const DISCORD_USER_ID = '424242424242424242';
const DISCORD_USERNAME = 'leaky-discord-name';
const PUBLIC_CLAN_ID = '019f9700-0000-7000-8000-000000000101';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const PUBLIC_ROUTE_FILES = ['public-stats.ts', 'public-clans.ts', 'public-banlist.ts'];

let h: IntegrationHarness;
let linkedPlayerId: string;
let ownerCookie: string;

describeIfDb('public surfaces never expose the Discord link (DISCORD-4)', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });

    const [linked] = await h.db
      .insert(players)
      .values({
        steamId64: LINKED_STEAM,
        canonicalName: 'Связанный игрок',
        canonicalNameNormalized: 'связанный игрок',
      })
      .returning({ id: players.id });
    linkedPlayerId = linked.id;

    await h.db.insert(playerDiscordLinks).values({
      playerId: linkedPlayerId,
      discordUserId: DISCORD_USER_ID,
      discordUsername: DISCORD_USERNAME,
    });

    await h.db.insert(clans).values({
      id: PUBLIC_CLAN_ID,
      name: 'Открытый клан',
      tags: ['PUB'],
      description: 'Публичное описание',
      isPublic: true,
    });
    // The clan_members trigger insists on exactly one leader per clan.
    await h.db
      .insert(clanMembers)
      .values({ clanId: PUBLIC_CLAN_ID, playerId: linkedPlayerId, memberRole: 'leader' });

    await h.db.insert(moderationActions).values({
      playerId: linkedPlayerId,
      actionType: 'ban',
      // Deliberately free of the substring the assertions search for, so the
      // `not.toContain('discord')` check cannot be satisfied by fixture noise.
      authorSystemLabel: 'public-leak-test',
      reason: 'cheating',
      context: { ban_length: '0' },
    });
    await h.db
      .insert(banlistPublicationSettings)
      .values({ id: 1, enabled: true, publishScope: 'all_active' })
      .onConflictDoUpdate({ target: banlistPublicationSettings.id, set: { enabled: true } });

    ownerCookie = await loginAsOwner(h);
  });

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  it('GET /api/v1/public/stats leaks neither the field name nor the Discord id', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/public/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('discord');
    expect(res.body).not.toContain(DISCORD_USER_ID);
    expect(res.body).not.toContain(DISCORD_USERNAME);
  });

  it('GET /api/v1/public/clans leaks neither the field name nor the Discord id', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/public/clans' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('discord');
    expect(res.body).not.toContain(DISCORD_USER_ID);
    expect(res.body).not.toContain(DISCORD_USERNAME);
  });

  it('GET /api/v1/public/clans/:id leaks neither the field name nor the Discord id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/public/clans/${PUBLIC_CLAN_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Связанный игрок');
    expect(res.body).not.toContain('discord');
    expect(res.body).not.toContain(DISCORD_USER_ID);
    expect(res.body).not.toContain(DISCORD_USERNAME);
  });

  it('GET /api/v1/public/banlist leaks neither the field name nor the Discord id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(String(LINKED_STEAM));
    expect(res.body).not.toContain('discord');
    expect(res.body).not.toContain(DISCORD_USER_ID);
    expect(res.body).not.toContain(DISCORD_USERNAME);
  });
});

describe('public route sources never reference the Discord link table', () => {
  it('no public-* route module mentions player_discord_links or discord_user_id', () => {
    const routesDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'src',
      'routes',
    );
    for (const file of PUBLIC_ROUTE_FILES) {
      const source = readFileSync(path.join(routesDir, file), 'utf8');
      expect(source, `${file} must not reference the Discord link table`).not.toMatch(
        /playerDiscordLinks|player_discord_links|discord_user_id/,
      );
    }
  });
});
