import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCombatEventToDossier,
  type DossierCombatEvent,
  type DossierSql,
  reconcileDossierAggregates,
} from '../src/dossier/aggregate.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMBAT_SQL = readFileSync(path.resolve(__dirname, '../sql/combat-events.sql'), 'utf-8');
const DOSSIER_MIGRATION = readFileSync(
  path.resolve(__dirname, '../drizzle/0037_dossier_weapon_vehicle_stats.sql'),
  'utf-8',
);

const SERVER = '000000e1-0000-4000-8000-0000000000e1';
// Regular (steam-linked) attacker and an EOS-only player (steam_id64 NULL).
const ATTACKER = '000000e2-0000-4000-9000-0000000000e2';
const EOS_ONLY = '000000e3-0000-4000-9000-0000000000e3';

let sql: ReturnType<typeof postgres>;
let monthStart: Date;

function ddlStatements(source: string): string[] {
  return source
    .split(/-->\s*statement-breakpoint\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function insertCombatEvent(exec: DossierSql, event: DossierCombatEvent): Promise<void> {
  await exec`
    INSERT INTO combat_events
      (event_type, server_id, attacker_player_id, victim_vehicle, attacker_vehicle,
       weapon, damage, is_teamkill, occurred_at)
    VALUES (${event.eventType}, ${SERVER}, ${event.attackerPlayerId}, ${event.victimVehicle},
       ${event.attackerVehicle}, ${event.weapon}, ${event.damage}, ${event.isTeamkill},
       ${event.occurredAt})
  `;
}

/** Insert the event into combat_events AND fold it into the dossier aggregates. */
async function ingest(event: DossierCombatEvent): Promise<void> {
  await sql.begin(async (tx) => {
    await insertCombatEvent(tx, event);
    await applyCombatEventToDossier(tx, event);
  });
}

function death(overrides: Partial<DossierCombatEvent> = {}): DossierCombatEvent {
  return {
    eventType: 'death',
    attackerPlayerId: ATTACKER,
    weapon: 'BP_AK74',
    attackerVehicle: null,
    victimVehicle: null,
    damage: null,
    isTeamkill: false,
    occurredAt: new Date(monthStart.getTime() + 1000),
    ...overrides,
  };
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe('DROP SCHEMA IF EXISTS dossier_dbtest CASCADE');
  await sql.unsafe('CREATE SCHEMA dossier_dbtest');
  await sql.unsafe('SET search_path TO dossier_dbtest, public');
  await sql.unsafe(COMBAT_SQL);
  for (const stmt of ddlStatements(DOSSIER_MIGRATION)) {
    await sql.unsafe(stmt);
  }

  await sql`
    INSERT INTO servers (id, display_name, slug)
    VALUES (${SERVER}, 'dossier-srv', 'dossier-srv')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO players (id, canonical_name, canonical_name_normalized, steam_id64) VALUES
      (${ATTACKER}, 'Attacker', 'attacker', 76561190000009001),
      (${EOS_ONLY}, 'EosOnly', 'eosonly', NULL)
    ON CONFLICT (id) DO NOTHING
  `;

  const [row] = await sql<
    { month_start: Date }[]
  >`SELECT date_trunc('month', now()) AS month_start`;
  monthStart = row.month_start;
}, 60_000);

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe('DROP SCHEMA IF EXISTS dossier_dbtest CASCADE');
  await sql`DELETE FROM players WHERE id = ANY(${[ATTACKER, EOS_ONLY]})`;
  await sql`DELETE FROM servers WHERE id = ${SERVER}`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await sql`DELETE FROM combat_events`;
  await sql`DELETE FROM player_weapon_stats`;
  await sql`DELETE FROM player_vehicle_stats`;
  await sql`DELETE FROM player_vehicle_kills`;
});

describeIfDb('applyCombatEventToDossier — incremental UPSERT', () => {
  it('increments per-weapon kills and stamps last_used_at on a kill', async () => {
    const at = new Date(monthStart.getTime() + 5000);
    await applyCombatEventToDossier(sql, death({ occurredAt: at }));

    const [row] = await sql<
      {
        kills: number;
        teamkills: number;
        shots_events: number;
        damage: string | null;
        last_used_at: Date;
      }[]
    >`SELECT kills, teamkills, shots_events, damage, last_used_at
        FROM player_weapon_stats WHERE player_id = ${ATTACKER} AND weapon = 'BP_AK74'`;
    expect(row.kills).toBe(1);
    expect(row.teamkills).toBe(0);
    expect(row.shots_events).toBe(0);
    expect(row.damage).toBeNull();
    expect(row.last_used_at.getTime()).toBe(at.getTime());
  });

  it('counts a teamkill as teamkills, not kills', async () => {
    await applyCombatEventToDossier(sql, death({ isTeamkill: true }));
    const [row] = await sql<{ kills: number; teamkills: number }[]>`
      SELECT kills, teamkills FROM player_weapon_stats WHERE player_id = ${ATTACKER}`;
    expect(row.kills).toBe(0);
    expect(row.teamkills).toBe(1);
  });

  it('accumulates damage and shots across damage events', async () => {
    await applyCombatEventToDossier(sql, death({ eventType: 'damage', damage: 40 }));
    await applyCombatEventToDossier(sql, death({ eventType: 'damage', damage: 60 }));
    const [row] = await sql<{ shots_events: number; damage: string }[]>`
      SELECT shots_events, damage FROM player_weapon_stats WHERE player_id = ${ATTACKER}`;
    expect(row.shots_events).toBe(2);
    expect(Number(row.damage)).toBe(100);
  });

  it('keeps damage NULL when the source event carries no damage magnitude', async () => {
    await applyCombatEventToDossier(sql, death({ eventType: 'damage', damage: null }));
    const [row] = await sql<{ shots_events: number; damage: string | null }[]>`
      SELECT shots_events, damage FROM player_weapon_stats WHERE player_id = ${ATTACKER}`;
    expect(row.shots_events).toBe(1);
    expect(row.damage).toBeNull();
  });

  it('does not overwrite an accumulated damage total with a later NULL-damage event', async () => {
    await applyCombatEventToDossier(sql, death({ eventType: 'damage', damage: 75 }));
    await applyCombatEventToDossier(sql, death({ eventType: 'damage', damage: null }));
    const [row] = await sql<{ shots_events: number; damage: string }[]>`
      SELECT shots_events, damage FROM player_weapon_stats WHERE player_id = ${ATTACKER}`;
    expect(row.shots_events).toBe(2);
    expect(Number(row.damage)).toBe(75);
  });

  it('records vehicle destruction with the correct (vehicle, weapon) pair', async () => {
    await applyCombatEventToDossier(
      sql,
      death({ eventType: 'vehicle_destroyed', weapon: 'BP_RPG7', victimVehicle: 'T72B3' }),
    );
    await applyCombatEventToDossier(
      sql,
      death({ eventType: 'vehicle_destroyed', weapon: 'BP_RPG7', victimVehicle: 'T72B3' }),
    );
    const [row] = await sql<{ destroyed_count: number }[]>`
      SELECT destroyed_count FROM player_vehicle_kills
      WHERE player_id = ${ATTACKER} AND victim_vehicle_asset_id = 'T72B3' AND weapon = 'BP_RPG7'`;
    expect(row.destroyed_count).toBe(2);
  });

  it('records per-vehicle kills/damage from the attacker vehicle', async () => {
    await applyCombatEventToDossier(sql, death({ attackerVehicle: 'BTR82A' }));
    await applyCombatEventToDossier(
      sql,
      death({ eventType: 'damage', damage: 30, attackerVehicle: 'BTR82A' }),
    );
    const [row] = await sql<{ kills: number; damage: string }[]>`
      SELECT kills, damage FROM player_vehicle_stats
      WHERE player_id = ${ATTACKER} AND vehicle_asset_id = 'BTR82A'`;
    expect(row.kills).toBe(1);
    expect(Number(row.damage)).toBe(30);
  });

  it('aggregates an EOS-only player (no steam_id64) by uuid', async () => {
    await applyCombatEventToDossier(sql, death({ attackerPlayerId: EOS_ONLY }));
    const [row] = await sql<{ kills: number }[]>`
      SELECT kills FROM player_weapon_stats WHERE player_id = ${EOS_ONLY}`;
    expect(row.kills).toBe(1);
  });

  it('ignores events with no resolvable attacker', async () => {
    await applyCombatEventToDossier(sql, death({ attackerPlayerId: null }));
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM player_weapon_stats`;
    expect(n).toBe(0);
  });
});

describeIfDb('reconcileDossierAggregates', () => {
  it('reports no drift when incremental aggregates match combat_events', async () => {
    await ingest(death({ occurredAt: new Date(monthStart.getTime() + 1000) }));
    await ingest(
      death({ eventType: 'damage', damage: 50, occurredAt: new Date(monthStart.getTime() + 2000) }),
    );
    await ingest(
      death({
        eventType: 'vehicle_destroyed',
        weapon: 'BP_RPG7',
        victimVehicle: 'BMP2',
        occurredAt: new Date(monthStart.getTime() + 3000),
      }),
    );

    const result = await reconcileDossierAggregates(sql);
    expect(result.discrepancies.total).toBe(0);
    expect(result.repaired).toBe(false);
  });

  it('detects and repairs aggregates that missed events (worker downtime gap)', async () => {
    // combat_events written, but the incremental path never ran → aggregates empty.
    await insertCombatEvent(sql, death({ occurredAt: new Date(monthStart.getTime() + 1000) }));
    await insertCombatEvent(sql, death({ occurredAt: new Date(monthStart.getTime() + 2000) }));
    await insertCombatEvent(
      sql,
      death({ eventType: 'damage', damage: 25, occurredAt: new Date(monthStart.getTime() + 3000) }),
    );

    const report = await reconcileDossierAggregates(sql);
    expect(report.discrepancies.weaponStats).toBeGreaterThan(0);
    expect(report.repaired).toBe(false);

    const repair = await reconcileDossierAggregates(sql, { repair: true });
    expect(repair.repaired).toBe(true);

    const [row] = await sql<{ kills: number; shots_events: number; damage: string }[]>`
      SELECT kills, shots_events, damage FROM player_weapon_stats
      WHERE player_id = ${ATTACKER} AND weapon = 'BP_AK74'`;
    expect(row.kills).toBe(2);
    expect(row.shots_events).toBe(1);
    expect(Number(row.damage)).toBe(25);

    // A second reconcile now sees a consistent state.
    const after = await reconcileDossierAggregates(sql);
    expect(after.discrepancies.total).toBe(0);
  });

  it('leaves aggregates untouched when an old combat_events partition is dropped', async () => {
    await ingest(death({ occurredAt: new Date(monthStart.getTime() + 1000) }));
    await ingest(death({ occurredAt: new Date(monthStart.getTime() + 2000) }));

    // Simulate a 24-month retention partition drop: the raw events vanish.
    await sql`DELETE FROM combat_events`;

    const [row] = await sql<{ kills: number }[]>`
      SELECT kills FROM player_weapon_stats WHERE player_id = ${ATTACKER} AND weapon = 'BP_AK74'`;
    expect(row.kills).toBe(2);
  });
});
