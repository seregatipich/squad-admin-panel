import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accrueDailyBonuses } from '../src/economy/accrual.js';
import { recomputeDailyPresence } from '../src/presence/daily.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PLAYER_STEAM = '000000a1-0000-4000-8000-000000000000';
const PLAYER_EOS = '000000e0-0000-4000-8000-000000000000';
const SERVER_1 = '00000011-0000-4000-8000-000000000000';
const SERVER_2 = '00000012-0000-4000-8000-000000000000';
const DAY = '2026-07-06';
const NOW = new Date('2026-07-07T00:00:00.000Z');

let sql: ReturnType<typeof postgres>;

interface SeedSession {
  playerId: string;
  serverId: string;
  connectedAt: string;
  disconnectedAt: string;
  mode?: string;
}

async function seedSession(session: SeedSession) {
  await sql`
    INSERT INTO player_sessions
      (player_id, server_id, connected_at, disconnected_at, duration_seconds, closed_reason, mode)
    VALUES (
      ${session.playerId},
      ${session.serverId},
      ${session.connectedAt}::timestamptz,
      ${session.disconnectedAt}::timestamptz,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${session.disconnectedAt}::timestamptz - ${session.connectedAt}::timestamptz))))::int,
      'disconnect',
      ${session.mode ?? 'online'}
    )
  `;
}

async function setEconomy(overrides: {
  enabled: boolean;
  kOnline?: number;
  kBoost?: number;
  kSeed?: number;
  seedThreshold?: number;
}) {
  await sql`
    UPDATE economy_settings
    SET economy_enabled = ${overrides.enabled},
        k_online = ${overrides.kOnline ?? 1},
        k_boost = ${overrides.kBoost ?? 2},
        k_seed = ${overrides.kSeed ?? 3},
        seed_threshold = ${overrides.seedThreshold ?? 40}
    WHERE id = 1
  `;
}

async function balanceOf(playerId: string): Promise<number> {
  const [row] = await sql<{ bonus_balance: number }[]>`
    SELECT bonus_balance FROM players WHERE id = ${playerId}
  `;
  return row?.bonus_balance ?? 0;
}

async function ledgerFor(playerId: string) {
  return sql<{ type: string; amount: number; reference_id: string | null }[]>`
    SELECT type, amount, reference_id
    FROM bonus_transactions
    WHERE player_id = ${playerId}
    ORDER BY type
  `;
}

async function recompute() {
  await recomputeDailyPresence(sql, { fromDay: DAY, toDay: DAY, now: NOW });
}

async function seedSeedingTransition(
  serverId: string,
  kind: 'server.seeding_started' | 'server.seeding_ended',
  occurredAt: string,
) {
  await sql`
    INSERT INTO events (event_id, server_id, occurred_at, kind, actor_kind, actor_id, payload)
    VALUES (
      gen_random_uuid(),
      ${serverId},
      ${occurredAt}::timestamptz,
      ${kind},
      'system',
      NULL,
      ${JSON.stringify({ player_count: 10, layer: null, live_at: 60, hysteresis: 5, progress_pct: 16 })}::jsonb
    )
  `;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql`
    INSERT INTO players (id, canonical_name, canonical_name_normalized, steam_id64, eos_id)
    VALUES (${PLAYER_STEAM}, 'Steamer', 'steamer', 76561190000000001, 'eos-steamer')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO players (id, canonical_name, canonical_name_normalized, steam_id64, eos_id)
    VALUES (${PLAYER_EOS}, 'EosOnly', 'eosonly', NULL, 'eos-only-1')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO servers (id, display_name, slug)
    VALUES (${SERVER_1}, 'srv-1', 'srv-1')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO servers (id, display_name, slug)
    VALUES (${SERVER_2}, 'srv-2', 'srv-2')
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(async () => {
  if (!sql) return;
  await sql`TRUNCATE bonus_transactions`;
  await sql`TRUNCATE player_daily_presence`;
  await sql`TRUNCATE player_sessions`;
  await sql`DELETE FROM events WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM servers WHERE id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM players WHERE id = ANY(${[PLAYER_STEAM, PLAYER_EOS]})`;
  await sql`UPDATE economy_settings SET economy_enabled = false WHERE id = 1`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await sql`TRUNCATE bonus_transactions`;
  await sql`TRUNCATE player_daily_presence`;
  await sql`TRUNCATE player_sessions`;
  await sql`DELETE FROM events WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`UPDATE players SET bonus_balance = 0`;
});

describeIfDb('accrueDailyBonuses', () => {
  it('accrues 2h online + 1h boost at default coefficients (no seed above threshold)', async () => {
    // Non-overlapping sessions → concurrency 1; threshold 1 → 1 is not < 1 → no seed.
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_1,
      connectedAt: `${DAY}T10:00:00.000Z`,
      disconnectedAt: `${DAY}T12:00:00.000Z`,
      mode: 'online',
    });
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_1,
      connectedAt: `${DAY}T13:00:00.000Z`,
      disconnectedAt: `${DAY}T14:00:00.000Z`,
      mode: 'boost',
    });
    await recompute();
    await setEconomy({ enabled: true, seedThreshold: 1 });

    const result = await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    expect(result.economyEnabled).toBe(true);
    expect(result.balanceDelta).toBe(4);
    const ledger = await ledgerFor(PLAYER_STEAM);
    expect(ledger).toEqual([
      { type: 'earn_boost', amount: 2, reference_id: DAY },
      { type: 'earn_online', amount: 2, reference_id: DAY },
    ]);
    expect(await balanceOf(PLAYER_STEAM)).toBe(4);
  });

  it('is idempotent: re-running the same day does not double the balance', async () => {
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_1,
      connectedAt: `${DAY}T10:00:00.000Z`,
      disconnectedAt: `${DAY}T12:00:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: true, seedThreshold: 1 });

    await accrueDailyBonuses(sql, { day: DAY, now: NOW });
    const secondRun = await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    expect(secondRun.balanceDelta).toBe(0);
    expect(await balanceOf(PLAYER_STEAM)).toBe(2);
    const online = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM bonus_transactions
      WHERE player_id = ${PLAYER_STEAM} AND type = 'earn_online' AND reference_id = ${DAY}
    `;
    expect(online[0]?.n).toBe(1);
  });

  it('accrues earn_seed for a session on a below-threshold server', async () => {
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_1,
      connectedAt: `${DAY}T10:00:00.000Z`,
      disconnectedAt: `${DAY}T11:00:00.000Z`,
      mode: 'online',
    });
    await recompute();
    // seed_threshold 40, single connected player → 1 < 40 → seed time = 1h.
    await setEconomy({ enabled: true, seedThreshold: 40 });

    await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    const ledger = await ledgerFor(PLAYER_STEAM);
    expect(ledger).toEqual([
      { type: 'earn_online', amount: 1, reference_id: DAY }, // round(1 * 3600/3600)
      { type: 'earn_seed', amount: 3, reference_id: DAY }, // round(3 * 3600/3600)
    ]);
    expect(await balanceOf(PLAYER_STEAM)).toBe(4);
    const [presence] = await sql<{ seed_seconds: number }[]>`
      SELECT seed_seconds FROM player_daily_presence
      WHERE player_id = ${PLAYER_STEAM} AND day = ${DAY}::date AND server_id = ${SERVER_1}
    `;
    expect(presence?.seed_seconds).toBe(3600);
  });

  it('accrues for an EOS-only player (no steam_id64) the same as everyone', async () => {
    await seedSession({
      playerId: PLAYER_EOS,
      serverId: SERVER_1,
      connectedAt: `${DAY}T08:00:00.000Z`,
      disconnectedAt: `${DAY}T10:00:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: true, seedThreshold: 1 });

    await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    const ledger = await ledgerFor(PLAYER_EOS);
    expect(ledger).toEqual([{ type: 'earn_online', amount: 2, reference_id: DAY }]);
    expect(await balanceOf(PLAYER_EOS)).toBe(2);
  });

  it('writes no ledger rows when the economy is disabled', async () => {
    // Seed attribution still runs with the economy off (see the LEAD-6 test
    // below), but no bonus ledger rows or balance changes may be produced.
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_1,
      connectedAt: `${DAY}T10:00:00.000Z`,
      disconnectedAt: `${DAY}T12:00:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: false, seedThreshold: 1 });

    const result = await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    expect(result.economyEnabled).toBe(false);
    expect(result.transactionsWritten).toBe(0);
    expect(result.balanceDelta).toBe(0);
    expect(await balanceOf(PLAYER_STEAM)).toBe(0);
    const ledger = await ledgerFor(PLAYER_STEAM);
    expect(ledger).toEqual([]);
  });

  it('persists seed_seconds with the economy off but writes no ledger rows (LEAD-6, #177)', async () => {
    // A seeding-window session on SERVER_2: seed attribution must run and persist
    // seed_seconds even when the economy is disabled, so the seeding leaderboard
    // is never silently empty. No ledger rows or balance changes may result —
    // seeding accounting is decoupled from the monetization flag.
    await seedSeedingTransition(SERVER_2, 'server.seeding_started', `${DAY}T10:00:00.000Z`);
    await seedSeedingTransition(SERVER_2, 'server.seeding_ended', `${DAY}T10:30:00.000Z`);
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_2,
      connectedAt: `${DAY}T10:00:00.000Z`,
      disconnectedAt: `${DAY}T10:30:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: false, kSeed: 3, seedThreshold: 100 });

    const result = await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    expect(result.economyEnabled).toBe(false);
    expect(result.transactionsWritten).toBe(0);
    expect(result.balanceDelta).toBe(0);
    expect(await balanceOf(PLAYER_STEAM)).toBe(0);
    expect(await ledgerFor(PLAYER_STEAM)).toEqual([]);

    // seed_seconds was still attributed from the session ∩ seeding-window overlap.
    const [presence] = await sql<{ seed_seconds: number }[]>`
      SELECT seed_seconds FROM player_daily_presence
      WHERE player_id = ${PLAYER_STEAM} AND day = ${DAY}::date AND server_id = ${SERVER_2}
    `;
    expect(presence?.seed_seconds).toBe(1800); // 30 min inside the seeding window
  });
});

describeIfDb('accrueDailyBonuses with SEED-1 seeding-window attribution', () => {
  it('attributes seed_seconds from session∩seeding-window intersection, splitting a session that crosses the seeding→live boundary', async () => {
    // Server has seeding events → window-based attribution applies instead of
    // the threshold sweep, even with a high seed_threshold that would
    // otherwise treat a lone connected player as seeding for the whole session.
    await seedSeedingTransition(SERVER_2, 'server.seeding_started', `${DAY}T10:00:00.000Z`);
    await seedSeedingTransition(SERVER_2, 'server.seeding_ended', `${DAY}T10:30:00.000Z`);

    // Session starts before the window and ends after it: only the 30 min
    // inside [10:00, 10:30) should count as seed time.
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_2,
      connectedAt: `${DAY}T09:45:00.000Z`,
      disconnectedAt: `${DAY}T11:00:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: true, kSeed: 3, seedThreshold: 100 });

    await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    const [presence] = await sql<{ seed_seconds: number }[]>`
      SELECT seed_seconds FROM player_daily_presence
      WHERE player_id = ${PLAYER_STEAM} AND day = ${DAY}::date AND server_id = ${SERVER_2}
    `;
    expect(presence?.seed_seconds).toBe(1800); // 30 minutes inside the window

    const ledger = await ledgerFor(PLAYER_STEAM);
    const seedTx = ledger.find((tx) => tx.type === 'earn_seed');
    expect(seedTx?.amount).toBe(2); // round(3 * 1800 / 3600) = round(1.5) = 2
  });

  it('recovers a server already seeding at day start from the pre-day transition', async () => {
    // seeding_started the day before; seeding_ended partway through the target day.
    await seedSeedingTransition(SERVER_2, 'server.seeding_started', `2026-07-05T23:00:00.000Z`);
    await seedSeedingTransition(SERVER_2, 'server.seeding_ended', `${DAY}T02:00:00.000Z`);

    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_2,
      connectedAt: `${DAY}T00:00:00.000Z`,
      disconnectedAt: `${DAY}T04:00:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: true, seedThreshold: 100 });

    await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    const [presence] = await sql<{ seed_seconds: number }[]>`
      SELECT seed_seconds FROM player_daily_presence
      WHERE player_id = ${PLAYER_STEAM} AND day = ${DAY}::date AND server_id = ${SERVER_2}
    `;
    // Day starts already seeding (00:00) through 02:00 → 2h = 7200s.
    expect(presence?.seed_seconds).toBe(7200);
  });

  it('falls back to the threshold sweep, unchanged, for a server with no seeding events at all', async () => {
    // SERVER_1 has never emitted a seeding event in this suite; a lone
    // connected player below seed_threshold still accrues seed time exactly
    // as before window-based attribution existed (regression guard).
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_1,
      connectedAt: `${DAY}T10:00:00.000Z`,
      disconnectedAt: `${DAY}T11:00:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: true, seedThreshold: 40 });

    await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    const [presence] = await sql<{ seed_seconds: number }[]>`
      SELECT seed_seconds FROM player_daily_presence
      WHERE player_id = ${PLAYER_STEAM} AND day = ${DAY}::date AND server_id = ${SERVER_1}
    `;
    expect(presence?.seed_seconds).toBe(3600);
  });

  it('is idempotent for window-based attribution: re-running the same day does not double-count the balance', async () => {
    await seedSeedingTransition(SERVER_2, 'server.seeding_started', `${DAY}T10:00:00.000Z`);
    await seedSeedingTransition(SERVER_2, 'server.seeding_ended', `${DAY}T10:30:00.000Z`);
    await seedSession({
      playerId: PLAYER_STEAM,
      serverId: SERVER_2,
      connectedAt: `${DAY}T10:00:00.000Z`,
      disconnectedAt: `${DAY}T10:30:00.000Z`,
      mode: 'online',
    });
    await recompute();
    await setEconomy({ enabled: true, kSeed: 3, seedThreshold: 100 });

    const first = await accrueDailyBonuses(sql, { day: DAY, now: NOW });
    const second = await accrueDailyBonuses(sql, { day: DAY, now: NOW });

    expect(second.balanceDelta).toBe(0);
    expect(await balanceOf(PLAYER_STEAM)).toBe(first.balanceDelta);
    const seedTxCount = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM bonus_transactions
      WHERE player_id = ${PLAYER_STEAM} AND type = 'earn_seed' AND reference_id = ${DAY}
    `;
    expect(seedTxCount[0]?.n).toBe(1);
  });
});
