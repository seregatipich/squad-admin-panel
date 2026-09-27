import {
  alertEvents,
  alertRules,
  type DatabaseClient,
  playerIpHistory,
  players,
  roles,
} from '@squad/db';
import { DEDUP_KEY, DEDUP_TTL_SECONDS, type EventEnvelope } from '@squad/shared-types';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  type AdminContext,
  ALERT_CHANNELS,
  ALERT_SEVERITIES,
  type AlertChannel,
  type AlertEventDraft,
  type AlertRuleInput,
  type AlertRuleType,
  type EvaluationContext,
  evaluate,
} from './engine.js';
import { type AlertSinkDeps, deliverAlert } from './sink.js';

/**
 * Runtime for the AUTO-3 alert rules (#19): loads the enabled `alert_rules`,
 * builds the evaluation context each rule type needs, runs {@link evaluate}
 * for every event parsed from a server log, and records each firing in
 * `alert_events` (plus an `alert.triggered` live-bus frame and channel
 * delivery through `sink.ts`).
 *
 * Only log-derived events reach this module — worker-log-ingest calls it from
 * its per-line pipeline. `custom` rules whose `eventKind` is produced outside
 * the log (`bansync.failed`, `externalban.matched`, `alt.ban_evasion_suspected`,
 * `reports.spam_flagged`, seed notifications) keep being raised by their own
 * producers; none of those kinds is ever emitted by the log parser, so a rule
 * never fires twice for one occurrence.
 */

const DEFAULT_TTL_MS = 15_000;

/** Window used when a stored `unusual_activity` rule predates `windowMinutes` (the UI default). */
const DEFAULT_UNUSUAL_WINDOW_MINUTES = 5;

/** Consumer-group label for the per-event dedup key (the tail replays its last lines). */
const ALERT_DEDUP_GROUP = 'log-ingest-alerts:v1';

/** Rule types evaluated from the event stream; `role_expiring` is scheduled by worker-role-expirer. */
const STREAM_RULE_TYPES = [
  'server_crashed',
  'unusual_activity',
  'admin_login_new_ip',
  'custom',
] as const satisfies readonly AlertRuleType[];

// An unknown severity falls back to the rule type's default instead of
// disabling the rule, matching the engine's own `readSeverity`.
const severitySchema = z.enum(ALERT_SEVERITIES).optional().catch(undefined);
const severityOnlyConfigSchema = z.object({ severity: severitySchema });
const CONFIG_SCHEMAS = {
  server_crashed: severityOnlyConfigSchema,
  admin_login_new_ip: severityOnlyConfigSchema,
  unusual_activity: z.object({
    windowMinutes: z.number().positive().default(DEFAULT_UNUSUAL_WINDOW_MINUTES),
    connectThreshold: z.number().positive(),
    severity: severitySchema,
  }),
  custom: z.object({
    eventKind: z.string().trim().min(1),
    threshold: z.number().nonnegative().optional(),
    severity: severitySchema,
  }),
} satisfies Record<(typeof STREAM_RULE_TYPES)[number], z.ZodTypeAny>;

const channelsSchema = z.array(z.enum(ALERT_CHANNELS)).catch([]);

export interface AlertRuleCacheOptions {
  /** How long a loaded rule set is reused; `0` reloads on every call. */
  ttlMs?: number;
  /** Called once per load for each enabled rule whose stored config is invalid (it is skipped). */
  onInvalidRule?: (ruleId: string, reason: string) => void;
}

/**
 * In-memory, TTL-refreshed snapshot of the enabled stream-evaluated alert
 * rules, mirroring {@link BannedNameRuleCache}: reloading is lazy, so an idle
 * worker never polls the database. Each row's `config` is validated against
 * its type's schema; a row that fails is skipped and reported through
 * `onInvalidRule` rather than evaluated with a guessed shape.
 */
export class AlertRuleCache {
  private rules: AlertRuleInput[] = [];
  private loadedAt = 0;
  private readonly ttlMs: number;
  private readonly onInvalidRule: AlertRuleCacheOptions['onInvalidRule'];

  constructor(
    private readonly db: DatabaseClient,
    options: AlertRuleCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.onInvalidRule = options.onInvalidRule;
  }

  /** Returns the enabled, valid rules, reloading them when the snapshot is older than the TTL. */
  async enabledRules(): Promise<AlertRuleInput[]> {
    if (this.loadedAt !== 0 && Date.now() - this.loadedAt < this.ttlMs) return this.rules;
    const rows = await this.db
      .select({
        id: alertRules.id,
        name: alertRules.name,
        type: alertRules.type,
        config: alertRules.config,
        channels: alertRules.channels,
      })
      .from(alertRules)
      .where(and(eq(alertRules.enabled, true), inArray(alertRules.type, [...STREAM_RULE_TYPES])));
    const rules: AlertRuleInput[] = [];
    for (const row of rows) {
      const type = row.type as (typeof STREAM_RULE_TYPES)[number];
      const parsed = CONFIG_SCHEMAS[type].safeParse(row.config ?? {});
      if (!parsed.success) {
        this.onInvalidRule?.(row.id, parsed.error.issues.map((issue) => issue.message).join('; '));
        continue;
      }
      rules.push({
        id: row.id,
        name: row.name,
        type,
        config: parsed.data,
        channels: channelsSchema.parse(row.channels) as AlertChannel[],
        enabled: true,
      });
    }
    this.rules = rules;
    this.loadedAt = Date.now();
    return rules;
  }
}

export type AlertEventOutcome =
  | { outcome: 'no_rules' | 'duplicate' }
  | { outcome: 'evaluated'; raised: number; suppressed: number };

function connectsKey(serverId: string): string {
  return `alerts:connects:${serverId}`;
}

function cooldownKey(ruleId: string, serverId: string): string {
  return `alerts:cooldown:${ruleId}:${serverId}`;
}

function customCountKey(ruleId: string, serverId: string): string {
  return `alerts:custom-count:${ruleId}:${serverId}`;
}

function windowMs(rule: AlertRuleInput): number {
  const { windowMinutes } = rule.config as { windowMinutes: number };
  return windowMinutes * 60_000;
}

function readPayloadString(event: EventEnvelope, key: string): string | null {
  const payload = event.payload as Record<string, unknown> | null;
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Resolves whether the connecting player is a panel admin (an unexpired role
 * with `panel_access`, or the system Owner role — the rule `rbac.ts` applies)
 * and which IPs their history already holds. Must run before the identity
 * handler records this connect's IP, or every IP would look known.
 */
async function loadAdminContext(
  db: DatabaseClient,
  event: EventEnvelope,
): Promise<AdminContext | null> {
  const steamId64 = readPayloadString(event, 'steam_id64');
  const eosId = readPayloadString(event, 'eos_id');
  const identity = [
    ...(steamId64 && /^\d+$/.test(steamId64) ? [eq(players.steamId64, BigInt(steamId64))] : []),
    ...(eosId ? [eq(players.eosId, eosId)] : []),
  ];
  if (identity.length === 0) return null;
  const [admin] = await db
    .select({
      playerId: players.id,
      panelAccess: roles.panelAccess,
      roleName: roles.name,
      isSystemRole: roles.isSystemRole,
    })
    .from(players)
    .innerJoin(roles, eq(roles.id, players.roleId))
    .where(
      and(
        or(...identity),
        or(isNull(players.roleExpiresAt), gt(players.roleExpiresAt, sql`now()`)),
      ),
    )
    .limit(1);
  if (!admin) return null;
  const isPanelAdmin = admin.panelAccess || (admin.roleName === 'Owner' && admin.isSystemRole);
  if (!isPanelAdmin) return { isPanelAdmin: false, knownIps: [], playerId: admin.playerId };
  const history = await db
    .select({ ip: sql<string>`host(${playerIpHistory.ip})` })
    .from(playerIpHistory)
    .where(eq(playerIpHistory.playerId, admin.playerId));
  return { isPanelAdmin: true, knownIps: history.map((row) => row.ip), playerId: admin.playerId };
}

/**
 * Builds the context one rule needs for this event. Per rule because the
 * inputs are rule-scoped: each `unusual_activity` rule has its own window and
 * each `custom` threshold its own counter.
 */
async function contextFor(
  redis: Redis,
  event: EventEnvelope,
  rule: AlertRuleInput,
  loadAdmin: () => Promise<AdminContext | null>,
): Promise<EvaluationContext> {
  const serverId = event.server_id;
  if (rule.type === 'unusual_activity' && event.type === 'player.connected' && serverId) {
    const now = Date.parse(event.ts);
    const count = await redis.zcount(connectsKey(serverId), now - windowMs(rule), now);
    return { recentConnectCount: count };
  }
  if (rule.type === 'admin_login_new_ip' && event.type === 'player.connected') {
    return { admin: await loadAdmin() };
  }
  if (rule.type === 'custom' && serverId) {
    const { eventKind, threshold } = rule.config as { eventKind: string; threshold?: number };
    if (eventKind === event.type && threshold && threshold > 0) {
      const count = await redis.incr(customCountKey(rule.id, serverId));
      return { customCounts: { [rule.id]: count } };
    }
  }
  return {};
}

/**
 * Records a `player.connected` in the server's sliding connect window (a
 * sorted set scored by event time, keyed by event id so a replayed line is
 * not counted twice) and trims what no rule's window can still see.
 */
async function recordConnect(
  redis: Redis,
  event: EventEnvelope,
  rules: readonly AlertRuleInput[],
): Promise<void> {
  const serverId = event.server_id;
  const windows = rules.filter((rule) => rule.type === 'unusual_activity').map(windowMs);
  if (!serverId || event.type !== 'player.connected' || windows.length === 0) return;
  const key = connectsKey(serverId);
  const now = Date.parse(event.ts);
  const longest = Math.max(...windows);
  await redis.zadd(key, now, event.event_id);
  await redis.zremrangebyscore(key, '-inf', now - longest);
  await redis.pexpire(key, longest);
}

/**
 * Applies the per-rule firing policy on top of the engine's verdict:
 * `unusual_activity` fires at most once per window per server (otherwise every
 * further connect in a flood would raise another alert), and a `custom`
 * threshold counter restarts after each firing so the rule fires once per
 * `threshold` matching events.
 */
async function claimFiring(
  redis: Redis,
  event: EventEnvelope,
  rule: AlertRuleInput,
): Promise<boolean> {
  const serverId = event.server_id ?? 'global';
  if (rule.type === 'unusual_activity') {
    const claimed = await redis.set(
      cooldownKey(rule.id, serverId),
      '1',
      'PX',
      windowMs(rule),
      'NX',
    );
    return claimed === 'OK';
  }
  if (rule.type === 'custom') await redis.del(customCountKey(rule.id, serverId));
  return true;
}

/**
 * Delivers the alert through the rule's channels, stores it in `alert_events`
 * with the delivery result, and announces it on the live bus. The live frame
 * carries no payload fields beyond identifiers: every panel viewer receives
 * it, and an `admin_login_new_ip` payload holds an IP address.
 */
async function raiseAlert(
  db: DatabaseClient,
  redis: Redis,
  event: EventEnvelope,
  rule: AlertRuleInput,
  draft: AlertEventDraft,
  sink: AlertSinkDeps,
): Promise<void> {
  const delivery = await deliverAlert(draft, rule.channels, sink);
  await db.insert(alertEvents).values({
    id: uuidv7(),
    ruleId: draft.ruleId,
    severity: draft.severity,
    payload: draft.payload,
    delivered: delivery.delivered,
  });
  await redis.publish(
    'live-bus',
    JSON.stringify({
      type: 'alert.triggered',
      ts: new Date().toISOString(),
      data: {
        event_kind: rule.type,
        rule_id: draft.ruleId,
        rule_name: draft.ruleName,
        severity: draft.severity,
        server_id: event.server_id,
      },
    }),
  );
}

/**
 * Evaluates every enabled alert rule against one parsed log event and raises
 * the ones that fire.
 *
 * Idempotent per `event_id`: the container tail replays its last lines on
 * every reattach, so the first call claims a Redis dedup key and replays
 * return `duplicate` without side effects.
 *
 * @param db - panel database (rules, admin/IP lookups, `alert_events` writes)
 * @param redis - dedup, connect-window, cooldown and counter keys; live-bus publish
 * @param rules - cached rule snapshot
 * @param event - an envelope produced by the log parser
 * @param sink - channel transports; without them delivery is recorded as not delivered
 * @returns how many alerts were raised and how many firings the cooldown suppressed
 * @throws when the database or Redis is unreachable; the caller logs and moves on
 */
export async function handleAlertEvent(
  db: DatabaseClient,
  redis: Redis,
  rules: Pick<AlertRuleCache, 'enabledRules'>,
  event: EventEnvelope,
  sink: AlertSinkDeps = {},
): Promise<AlertEventOutcome> {
  const enabled = await rules.enabledRules();
  if (enabled.length === 0) return { outcome: 'no_rules' };

  const claim = await redis.set(
    DEDUP_KEY(ALERT_DEDUP_GROUP, event.event_id),
    '1',
    'EX',
    DEDUP_TTL_SECONDS,
    'NX',
  );
  if (!claim) return { outcome: 'duplicate' };

  await recordConnect(redis, event, enabled);

  let adminContext: Promise<AdminContext | null> | null = null;
  const loadAdmin = () => {
    adminContext ??= loadAdminContext(db, event);
    return adminContext;
  };

  let raised = 0;
  let suppressed = 0;
  for (const rule of enabled) {
    const context = await contextFor(redis, event, rule, loadAdmin);
    const [draft] = evaluate(event, [rule], context);
    if (!draft) continue;
    if (!(await claimFiring(redis, event, rule))) {
      suppressed += 1;
      continue;
    }
    await raiseAlert(db, redis, event, rule, draft, sink);
    raised += 1;
  }
  return { outcome: 'evaluated', raised, suppressed };
}
