import type { EventEnvelope } from '@squad/shared-types';

export const ALERT_RULE_TYPES = [
  'server_crashed',
  'unusual_activity',
  'admin_login_new_ip',
  'custom',
] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_CHANNELS = ['email', 'webpush'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export interface UnusualActivityConfig {
  windowMinutes: number;
  connectThreshold: number;
}

export interface CustomConfig {
  eventKind: string;
  threshold?: number;
  severity?: AlertSeverity;
}

export interface SeverityOverrideConfig {
  severity?: AlertSeverity;
}

export type AlertRuleConfig =
  | UnusualActivityConfig
  | CustomConfig
  | SeverityOverrideConfig
  | Record<string, unknown>;

export interface AlertRuleInput {
  id: string;
  name: string;
  type: AlertRuleType;
  config: AlertRuleConfig;
  channels: AlertChannel[];
  enabled: boolean;
}

export interface AdminContext {
  isPanelAdmin: boolean;
  knownIps: readonly string[];
}

export interface EvaluationContext {
  recentConnectCount?: number;
  admin?: AdminContext | null;
  customCounts?: Record<string, number>;
}

export interface AlertEventDraft {
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
}

function readSeverity(value: unknown, fallback: AlertSeverity): AlertSeverity {
  return value === 'info' || value === 'warning' || value === 'critical' ? value : fallback;
}

function readString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const raw = (source as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : null;
}

function evaluateServerCrashed(event: EventEnvelope, rule: AlertRuleInput): AlertEventDraft | null {
  if (event.type !== 'server.crashed') return null;
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: readSeverity((rule.config as SeverityOverrideConfig).severity, 'critical'),
    payload: { eventType: event.type, serverId: event.server_id, occurredAt: event.ts },
  };
}

function evaluateUnusualActivity(
  event: EventEnvelope,
  rule: AlertRuleInput,
  context: EvaluationContext,
): AlertEventDraft | null {
  if (event.type !== 'player.connected') return null;
  const config = rule.config as UnusualActivityConfig;
  const threshold = config.connectThreshold;
  const observed = context.recentConnectCount ?? 0;
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  if (observed < threshold) return null;
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: readSeverity((config as SeverityOverrideConfig).severity, 'warning'),
    payload: {
      eventType: event.type,
      serverId: event.server_id,
      connectCount: observed,
      windowMinutes: config.windowMinutes,
      threshold,
    },
  };
}

function evaluateAdminLoginNewIp(
  event: EventEnvelope,
  rule: AlertRuleInput,
  context: EvaluationContext,
): AlertEventDraft | null {
  if (event.type !== 'player.connected') return null;
  const admin = context.admin;
  if (!admin || !admin.isPanelAdmin) return null;
  const ip = readString(event.payload, 'ip');
  if (!ip) return null;
  if (admin.knownIps.includes(ip)) return null;
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: readSeverity((rule.config as SeverityOverrideConfig).severity, 'warning'),
    payload: {
      eventType: event.type,
      serverId: event.server_id,
      actorId: event.actor?.id ?? null,
      ip,
    },
  };
}

function evaluateCustom(
  event: EventEnvelope,
  rule: AlertRuleInput,
  context: EvaluationContext,
): AlertEventDraft | null {
  const config = rule.config as CustomConfig;
  if (typeof config.eventKind !== 'string' || config.eventKind.length === 0) return null;
  if (event.type !== config.eventKind) return null;
  if (typeof config.threshold === 'number' && config.threshold > 0) {
    const observed = context.customCounts?.[rule.id] ?? 0;
    if (observed < config.threshold) return null;
  }
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: readSeverity(config.severity, 'info'),
    payload: {
      eventType: event.type,
      serverId: event.server_id,
      matchedKind: config.eventKind,
    },
  };
}

function evaluateRule(
  event: EventEnvelope,
  rule: AlertRuleInput,
  context: EvaluationContext,
): AlertEventDraft | null {
  switch (rule.type) {
    case 'server_crashed':
      return evaluateServerCrashed(event, rule);
    case 'unusual_activity':
      return evaluateUnusualActivity(event, rule, context);
    case 'admin_login_new_ip':
      return evaluateAdminLoginNewIp(event, rule, context);
    case 'custom':
      return evaluateCustom(event, rule, context);
    default:
      return null;
  }
}

export function evaluate(
  event: EventEnvelope,
  rules: readonly AlertRuleInput[],
  context: EvaluationContext = {},
): AlertEventDraft[] {
  const drafts: AlertEventDraft[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const draft = evaluateRule(event, rule, context);
    if (draft) drafts.push(draft);
  }
  return drafts;
}
