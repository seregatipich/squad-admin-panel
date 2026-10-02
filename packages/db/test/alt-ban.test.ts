import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { raiseAltBanAlert } from '../src/alt-ban.js';
import { createDatabaseClient, type DatabaseClient } from '../src/client.js';
import { describeIfDb } from './helpers/describe-if.js';

const DATABASE_URL = process.env.DATABASE_URL;

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;

const PLAYER = '0a17ba17-0000-4000-8000-000000000001';

async function insertRule(config: postgres.JSONValue, enabled = true): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO alert_rules (id, name, type, config, enabled)
    VALUES (${id}, ${`rule-${id.slice(0, 8)}`}, 'custom', ${sql.json(config)}, ${enabled})
  `;
  return id;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  db = createDatabaseClient(DATABASE_URL);
  await sql`
    INSERT INTO players (id, canonical_name, canonical_name_normalized)
    VALUES (${PLAYER}, 'P-altban', 'p-altban')
    ON CONFLICT (id) DO NOTHING
  `;
});

afterEach(async () => {
  if (!sql) return;
  await sql`DELETE FROM alert_events`;
  await sql`DELETE FROM alert_rules`;
});

afterAll(async () => {
  if (!sql) return;
  await sql`DELETE FROM players WHERE id = ${PLAYER}`;
  await sql.end({ timeout: 5 });
});

describeIfDb('raiseAltBanAlert (#1094)', () => {
  const payload = {
    trigger: 'admin_ban' as const,
    target_player_id: PLAYER,
    confirmed_alt_ids: [],
    candidate_ids: [],
  };
  const publisher = { publish: async () => undefined };

  it('skips a rule whose config has an invalid severity instead of aborting the whole batch', async () => {
    // Before the fix, an unchecked `rule.config as AltBanAlertRuleConfig`
    // cast let an invalid severity reach the INSERT, where
    // `alert_events_severity_chk` throws and — with no per-rule try/catch —
    // aborts the loop, silently dropping every rule after the bad one.
    await insertRule({ eventKind: 'alt.ban_evasion_suspected', severity: 'high' });
    const goodRuleId = await insertRule({
      eventKind: 'alt.ban_evasion_suspected',
      severity: 'critical',
    });

    const raised = await raiseAltBanAlert(db, publisher, payload);

    expect(raised).toBe(1);
    const events = await sql<{ rule_id: string; severity: string }[]>`
      SELECT rule_id, severity FROM alert_events
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.rule_id).toBe(goodRuleId);
    expect(events[0]?.severity).toBe('critical');
  });

  it('skips a rule with a non-object config without throwing', async () => {
    await insertRule('not-an-object');
    const goodRuleId = await insertRule({ eventKind: 'alt.ban_evasion_suspected' });

    const raised = await raiseAltBanAlert(db, publisher, payload);

    expect(raised).toBe(1);
    const events = await sql<{ rule_id: string }[]>`SELECT rule_id FROM alert_events`;
    expect(events.map((e) => e.rule_id)).toEqual([goodRuleId]);
  });

  it('defaults severity to warning when config omits it', async () => {
    await insertRule({ eventKind: 'alt.ban_evasion_suspected' });

    await raiseAltBanAlert(db, publisher, payload);

    const [event] = await sql<{ severity: string }[]>`SELECT severity FROM alert_events`;
    expect(event?.severity).toBe('warning');
  });

  it('ignores a disabled rule and a rule for a different event kind', async () => {
    await insertRule({ eventKind: 'alt.ban_evasion_suspected' }, false);
    await insertRule({ eventKind: 'other.kind' });

    const raised = await raiseAltBanAlert(db, publisher, payload);

    expect(raised).toBe(0);
  });
});
