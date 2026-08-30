import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { DatabaseClient } from '@squad/db';
import {
  matches,
  matchPlayers,
  playerKitTime,
  playerStatPeriods,
  players,
  playerVehicleKills,
  playerVehicleStats,
  playerWeaponStats,
  roles,
  servers,
} from '@squad/db/schema';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import playerDossierRoutes from '../../src/routes/player-dossier.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM = testSteamId(192001);
const SERVER_A = '019e0000-0000-7000-8000-0000000192a1';
const SERVER_B = '019e0000-0000-7000-8000-0000000192b2';

let h: IntegrationHarness;
let ownerCookie: string;
let playerId: string;
let emptyPlayerId: string;

interface DossierBody {
  skill: {
    kills: number;
    deaths: number;
    kd: number;
    teamkills: number;
    revives: number;
    damage_dealt: null;
    online_seconds: number;
    matches: number;
    wins: number;
    losses: number;
    draws: number;
    winrate: number | null;
  };
  kd_trend: { month: string; kills: number; deaths: number }[];
  weapons: {
    weapon: string;
    kills: number;
    teamkills: number;
    damage: number | null;
    shots_events: number;
    last_used_at: string | null;
  }[];
  weapons_total: number;
  vehicles: {
    vehicle_asset_id: string;
    name_en: string | null;
    name_ru: string | null;
    vehicle_class: string | null;
    unlocalized: boolean;
    kills: number;
    damage: number | null;
  }[];
  vehicle_kills: {
    victim_vehicle_asset_id: string;
    name_en: string | null;
    name_ru: string | null;
    vehicle_class: string | null;
    unlocalized: boolean;
    weapon: string;
    destroyed_count: number;
  }[];
  kits: { kit: string; seconds: number; last_played_at: string | null }[];
  period: string;
  server_id: string | null;
}

function fetchDossier(target = playerId, query = '', cookie = ownerCookie) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/players/${target}/dossier${query}`,
    headers: cookie ? { cookie } : undefined,
  });
}

async function loginAs(db: DatabaseClient, targetPlayerId: string): Promise<string> {
  invalidatePermissionCache(targetPlayerId);
  const { token } = await createSession(db, h.redis, {
    playerId: targetPlayerId,
    ip: null,
    userAgent: 'dossier-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  await h.db.insert(servers).values([
    { id: SERVER_A, displayName: 'Dossier A', slug: 'dossier-a' },
    { id: SERVER_B, displayName: 'Dossier B', slug: 'dossier-b' },
  ]);

  const inserted = await h.db
    .insert(players)
    .values([
      {
        steamId64: testSteamId(192002),
        canonicalName: 'DossierFull',
        canonicalNameNormalized: 'dossierfull',
        eosId: 'eos-dossier-full',
      },
      {
        steamId64: testSteamId(192003),
        canonicalName: 'DossierEmpty',
        canonicalNameNormalized: 'dossierempty',
        eosId: 'eos-dossier-empty',
      },
    ])
    .returning({ id: players.id });
  playerId = inserted[0].id;
  emptyPlayerId = inserted[1].id;

  // Server A: one win with 4/2, server B: one loss with 1/1 → lifetime 5 kills,
  // 3 deaths, 1W/1L, winrate 0.5; serverId=A → 4 kills, 1 match, 1 win.
  const [winMatch] = await h.db
    .insert(matches)
    .values({ serverId: SERVER_A, startedAt: new Date('2026-07-01T12:00:00Z'), winner: 'team1' })
    .returning({ id: matches.id });
  const [lossMatch] = await h.db
    .insert(matches)
    .values({ serverId: SERVER_B, startedAt: new Date('2026-07-02T12:00:00Z'), winner: 'team1' })
    .returning({ id: matches.id });
  await h.db.insert(matchPlayers).values([
    {
      matchId: winMatch.id,
      playerId,
      joinedAt: new Date('2026-07-01T12:00:00Z'),
      playSeconds: 600,
      team: 1,
      kills: 4,
      deaths: 2,
      teamkills: 1,
      revives: 2,
    },
    {
      matchId: lossMatch.id,
      playerId,
      joinedAt: new Date('2026-07-02T12:00:00Z'),
      playSeconds: 600,
      team: 2,
      kills: 1,
      deaths: 1,
      teamkills: 0,
      revives: 0,
    },
  ]);

  // Сидовый матч на том же сервере и в том же месяце. Числа нарочно крупные:
  // если фильтр `is_seed` где-нибудь потеряется, это увидит любая проверка.
  const [seedMatch] = await h.db
    .insert(matches)
    .values({
      serverId: SERVER_A,
      startedAt: new Date('2026-07-03T12:00:00Z'),
      winner: 'team1',
      isSeed: true,
    })
    .returning({ id: matches.id });
  await h.db.insert(matchPlayers).values({
    matchId: seedMatch.id,
    playerId,
    joinedAt: new Date('2026-07-03T12:00:00Z'),
    playSeconds: 600,
    team: 1,
    kills: 99,
    deaths: 1,
    teamkills: 9,
    revives: 9,
  });

  // Materialised month rows: the all-servers rollup (server_id NULL) plus the
  // per-server-A row. Их читает только «Онлайн» — тренд считается по матчам.
  await h.db.insert(playerStatPeriods).values([
    {
      playerId,
      serverId: null,
      periodType: 'month',
      periodStart: '2026-07-01',
      kills: 5,
      deaths: 3,
      kdRatio: 1.67,
      matchesPlayed: 2,
      onlineSeconds: 7200,
    },
    {
      playerId,
      serverId: SERVER_A,
      periodType: 'month',
      periodStart: '2026-07-01',
      kills: 4,
      deaths: 2,
      kdRatio: 2,
      matchesPlayed: 1,
      onlineSeconds: 3600,
    },
    // Месяц без единого матча: в график K/D он не попадает, но время на
    // сервере игрок в нём провёл, и «Онлайн» обязан его учесть.
    {
      playerId,
      serverId: null,
      periodType: 'month',
      periodStart: '2026-06-01',
      kills: 0,
      deaths: 0,
      kdRatio: 0,
      matchesPlayed: 0,
      onlineSeconds: 1800,
    },
  ]);

  await h.db.insert(playerWeaponStats).values([
    {
      playerId,
      weapon: 'BP_AK74',
      kills: 12,
      teamkills: 1,
      damage: '540.5',
      shotsEvents: 30,
      lastUsedAt: new Date('2026-06-01T10:00:00Z'),
    },
    {
      playerId,
      weapon: 'BP_M4',
      kills: 7,
      teamkills: 0,
      damage: '210',
      shotsEvents: 15,
      lastUsedAt: new Date('2026-06-02T10:00:00Z'),
    },
    { playerId, weapon: 'BP_Knife', kills: 3, teamkills: 0, damage: null, shotsEvents: 0 },
  ]);

  // BTR82A / M1A2 exist in the migration-seeded vehicle_catalog; the ZZ_*
  // asset ids deliberately do not.
  await h.db.insert(playerVehicleStats).values([
    { playerId, vehicleAssetId: 'BTR82A', kills: 5, damage: '320' },
    { playerId, vehicleAssetId: 'ZZ_UnknownVehicle', kills: 2, damage: null },
  ]);
  await h.db.insert(playerVehicleKills).values([
    { playerId, victimVehicleAssetId: 'M1A2', weapon: 'BP_RPG7', destroyedCount: 4 },
    { playerId, victimVehicleAssetId: 'ZZ_MysteryVictim', weapon: 'BP_AT4', destroyedCount: 1 },
  ]);

  await h.db.insert(playerKitTime).values([
    {
      playerId,
      kit: 'Medic',
      serverId: SERVER_A,
      seconds: 600,
      lastPlayedAt: new Date('2026-07-01T13:00:00Z'),
    },
    {
      playerId,
      kit: 'Medic',
      serverId: SERVER_B,
      seconds: 300,
      lastPlayedAt: new Date('2026-07-02T13:00:00Z'),
    },
    { playerId, kit: 'Rifleman', serverId: SERVER_A, seconds: 120, lastPlayedAt: null },
  ]);
});

afterAll(async () => {
  if (h) await h.cleanup();
});

describeIfDb('GET /api/v1/players/:playerId/dossier', () => {
  it('assembles all sections for a player with data everywhere', async () => {
    const res = await fetchDossier();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('miss');
    const body = res.json() as DossierBody;

    expect(body.skill).toEqual({
      kills: 5,
      deaths: 3,
      kd: expect.any(Number),
      teamkills: 1,
      revives: 2,
      damage_dealt: null,
      online_seconds: 9000,
      matches: 2,
      wins: 1,
      losses: 1,
      draws: 0,
      winrate: 0.5,
    });
    expect(body.kd_trend).toEqual([{ month: '2026-07-01', kills: 5, deaths: 3 }]);

    expect(body.weapons).toHaveLength(3);
    expect(body.weapons_total).toBe(3);
    expect(body.weapons[0]).toMatchObject({
      weapon: 'BP_AK74',
      kills: 12,
      teamkills: 1,
      damage: 540.5,
      shots_events: 30,
      last_used_at: '2026-06-01T10:00:00.000Z',
    });

    const btr = body.vehicles.find((v) => v.vehicle_asset_id === 'BTR82A');
    expect(btr).toMatchObject({
      name_en: 'BTR-82A',
      name_ru: 'БТР-82А',
      vehicle_class: 'IFV',
      unlocalized: false,
      kills: 5,
      damage: 320,
    });
    const abrams = body.vehicle_kills.find((v) => v.victim_vehicle_asset_id === 'M1A2');
    expect(abrams).toMatchObject({
      name_en: 'M1A2 Abrams',
      unlocalized: false,
      weapon: 'BP_RPG7',
      destroyed_count: 4,
    });

    expect(body.kits).toEqual([
      { kit: 'Medic', seconds: 900, last_played_at: '2026-07-02T13:00:00.000Z' },
      { kit: 'Rifleman', seconds: 120, last_played_at: null },
    ]);

    expect(body.period).toBe('all');
    expect(body.server_id).toBeNull();
  });

  it('returns 200 with zeros and empty arrays for a player without history', async () => {
    const res = await fetchDossier(emptyPlayerId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;
    expect(body.skill).toEqual({
      kills: 0,
      deaths: 0,
      kd: 0,
      teamkills: 0,
      revives: 0,
      damage_dealt: null,
      online_seconds: 0,
      matches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      winrate: null,
    });
    expect(body.kd_trend).toEqual([]);
    expect(body.weapons).toEqual([]);
    expect(body.weapons_total).toBe(0);
    expect(body.vehicles).toEqual([]);
    expect(body.vehicle_kills).toEqual([]);
    expect(body.kits).toEqual([]);
  });

  it('serializes damage as null, not 0', async () => {
    const res = await fetchDossier();
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;
    const knife = body.weapons.find((w) => w.weapon === 'BP_Knife');
    expect(knife).toBeDefined();
    expect(knife?.damage).toBeNull();
    expect(knife?.damage).not.toBe(0);
    const unknownVehicle = body.vehicles.find((v) => v.vehicle_asset_id === 'ZZ_UnknownVehicle');
    expect(unknownVehicle?.damage).toBeNull();
    expect(body.skill.damage_dealt).toBeNull();
  });

  it('unknown player id → 404 player_not_found', async () => {
    const res = await fetchDossier('019e0000-0000-7000-8000-00000000dead');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'player_not_found' });
  });

  it('unauthenticated → 401', async () => {
    const res = await fetchDossier(playerId, '', '');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('user without combatView → 403', async () => {
    const roleId = uuidv7();
    await h.db.insert(roles).values({
      id: roleId,
      name: `DossierGated-${roleId}`,
      color: 'neutral',
      isSystemRole: false,
      panelAccess: true,
      combatView: false,
    });
    const [gated] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(192004),
        canonicalName: 'DossierGated',
        canonicalNameNormalized: 'dossiergated',
        roleId,
      })
      .returning({ id: players.id });
    const gatedCookie = await loginAs(h.db, gated.id);

    const res = await fetchDossier(playerId, '', gatedCookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('свои цифры видны без combatView, чужие — нет', async () => {
    const roleId = uuidv7();
    await h.db.insert(roles).values({
      id: roleId,
      name: `DossierSelfGated-${roleId}`,
      color: 'neutral',
      isSystemRole: false,
      panelAccess: true,
      combatView: false,
    });
    const [selfGated] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(192005),
        canonicalName: 'DossierSelfGated',
        canonicalNameNormalized: 'dossierselfgated',
        roleId,
      })
      .returning({ id: players.id });
    const selfCookie = await loginAs(h.db, selfGated.id);

    const own = await fetchDossier(selfGated.id, '', selfCookie);
    expect(own.statusCode).toBe(200);

    const foreign = await fetchDossier(playerId, '', selfCookie);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ error: 'forbidden' });
  });

  it('Owner → 200', async () => {
    const res = await fetchDossier(playerId, `?serverId=${SERVER_B}`);
    expect(res.statusCode).toBe(200);
  });

  it('serverId uuid filters kits and skill; weapons stay lifetime', async () => {
    const res = await fetchDossier(playerId, `?serverId=${SERVER_A}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;

    expect(body.skill.kills).toBe(4);
    expect(body.skill.deaths).toBe(2);
    expect(body.skill.matches).toBe(1);
    expect(body.skill.wins).toBe(1);
    expect(body.skill.losses).toBe(0);
    expect(body.skill.online_seconds).toBe(3600);
    expect(body.kd_trend).toEqual([{ month: '2026-07-01', kills: 4, deaths: 2 }]);

    expect(body.kits).toEqual([
      { kit: 'Medic', seconds: 600, last_played_at: '2026-07-01T13:00:00.000Z' },
      { kit: 'Rifleman', seconds: 120, last_played_at: null },
    ]);

    // Weapon/vehicle aggregate tables carry no server dimension: lifetime.
    expect(body.weapons).toHaveLength(3);
    expect(body.weapons_total).toBe(3);
    expect(body.vehicles).toHaveLength(2);
    expect(body.period).toBe('all');
    expect(body.server_id).toBe(SERVER_A);
  });

  it('окно периода сужает «Онлайн» так же, как график', async () => {
    const res = await fetchDossier(playerId, '?from=2026-07-01');
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;

    // Месяц 2026-06 с его 1800 с остаётся за окном.
    expect(body.skill.online_seconds).toBe(7200);
    expect(body.kd_trend).toEqual([{ month: '2026-07-01', kills: 5, deaths: 3 }]);
  });

  it('верхняя граница окна тоже не роняет запрос', async () => {
    const res = await fetchDossier(playerId, '?from=2026-06-01&to=2026-06-30');
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;

    // Июнь у этого игрока — месяц без матчей: время есть, боя нет.
    expect(body.skill.online_seconds).toBe(1800);
    expect(body.skill.matches).toBe(0);
    expect(body.kd_trend).toEqual([]);
  });

  it('сидовые матчи не попадают ни в сводку, ни в график', async () => {
    const res = await fetchDossier();
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;

    // 99 убийств сидового матча остались снаружи — иначе было бы 104.
    expect(body.skill.kills).toBe(5);
    expect(body.skill.matches).toBe(2);
    expect(body.skill.teamkills).toBe(1);
    expect(body.kd_trend).toEqual([{ month: '2026-07-01', kills: 5, deaths: 3 }]);
  });

  it('unlocalized vehicles get unlocalized: true and null names', async () => {
    const res = await fetchDossier();
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;
    const unknownVehicle = body.vehicles.find((v) => v.vehicle_asset_id === 'ZZ_UnknownVehicle');
    expect(unknownVehicle).toMatchObject({
      name_en: null,
      name_ru: null,
      vehicle_class: null,
      unlocalized: true,
    });
    const unknownVictim = body.vehicle_kills.find(
      (v) => v.victim_vehicle_asset_id === 'ZZ_MysteryVictim',
    );
    expect(unknownVictim).toMatchObject({
      name_en: null,
      name_ru: null,
      vehicle_class: null,
      unlocalized: true,
      weapon: 'BP_AT4',
      destroyed_count: 1,
    });
  });

  it('weaponsLimit truncates weapons and weapons_total reports the full count', async () => {
    const res = await fetchDossier(playerId, '?weaponsLimit=2');
    expect(res.statusCode).toBe(200);
    const body = res.json() as DossierBody;
    expect(body.weapons).toHaveLength(2);
    expect(body.weapons.map((w) => w.weapon)).toEqual(['BP_AK74', 'BP_M4']);
    expect(body.weapons_total).toBe(3);
  });

  it('second call returns x-cache: hit', async () => {
    const first = await fetchDossier(playerId, '?weaponsLimit=7');
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');

    const second = await fetchDossier(playerId, '?weaponsLimit=7');
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.json()).toEqual(first.json());
  });
});

describe('dossier OpenAPI surface', () => {
  it('dossier schema visible in the OpenAPI document', async () => {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, {
      openapi: { info: { title: 'dossier-test', version: '0.0.0' } },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/api/docs' });
    await app.register(playerDossierRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      paths: Record<string, { get?: { parameters?: { name: string; in: string }[] } } | undefined>;
    };
    const dossierPath = doc.paths['/api/v1/players/{playerId}/dossier'];
    expect(dossierPath?.get).toBeDefined();
    const paramNames = (dossierPath?.get?.parameters ?? []).map((p) => p.name);
    expect(paramNames).toEqual(
      expect.arrayContaining(['playerId', 'from', 'to', 'serverId', 'weaponsLimit']),
    );
    await app.close();
  });
});
