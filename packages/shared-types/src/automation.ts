import { z } from 'zod';
import {
  RCON_OPERATOR_COMMAND_ARG_COUNTS,
  rconOperatorCommandNameSchema,
} from './rcon-commands.js';

/**
 * Automation trigger engine (AUTO-1, #72) contracts.
 *
 * A rule pairs one condition (of {@link AUTOMATION_CONDITION_TYPES}) with one
 * action (of {@link AUTOMATION_ACTION_TYPES}). The `condition`/`action` jsonb
 * columns are validated against the discriminated schemas below both at the API
 * boundary (`apps/api/src/routes/automation-rules.ts`) and by the evaluation
 * engine (`evaluate` in `./automation-engine.js`, re-exported by
 * `apps/workers/automation/src/rules/engine.ts`).
 */

export const AUTOMATION_CONDITION_TYPES = [
  'chat_keyword',
  'player_count',
  'time_of_day',
  'player_flag',
] as const;
export type AutomationConditionType = (typeof AUTOMATION_CONDITION_TYPES)[number];
export const automationConditionTypeSchema = z.enum(AUTOMATION_CONDITION_TYPES);

export const AUTOMATION_ACTION_TYPES = ['rcon_command', 'kick', 'warn', 'notify_admin'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];
export const automationActionTypeSchema = z.enum(AUTOMATION_ACTION_TYPES);

/**
 * Outcome recorded for a single rule evaluation/firing. `matched`/`no_match`
 * are dry-run test outcomes; `executed`/`failed`/`skipped` are real firings.
 * Kept in lockstep with the `automation_runs.status` check constraint in
 * `packages/db/src/schema/automation-rules.ts`.
 */
export const AUTOMATION_RUN_STATUSES = [
  'matched',
  'no_match',
  'executed',
  'failed',
  'skipped',
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AUTOMATION_NOTIFY_CHANNELS = ['email', 'webpush'] as const;
export type AutomationNotifyChannel = (typeof AUTOMATION_NOTIFY_CHANNELS)[number];

/** Maximum single-line text worker-rcon accepts for AdminWarn/AdminKick reason. */
const RCON_TEXT_MAX = 300;

// ---------------------------------------------------------------------------
// Condition config schemas
// ---------------------------------------------------------------------------

export const chatKeywordConditionSchema = z
  .object({
    keyword: z.string().trim().min(1).max(128),
    match: z.enum(['contains', 'exact', 'word']).default('contains'),
    caseSensitive: z.boolean().default(false),
  })
  .strict();
export type ChatKeywordCondition = z.infer<typeof chatKeywordConditionSchema>;

export const playerCountConditionSchema = z
  .object({
    operator: z.enum(['gte', 'lte', 'gt', 'lt', 'eq']).default('gte'),
    threshold: z.number().int().min(0).max(200),
  })
  .strict();
export type PlayerCountCondition = z.infer<typeof playerCountConditionSchema>;

/** True when `timeZone` is a zone the runtime's Intl database resolves. */
function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A daily time window expressed as minutes-since-midnight in `timezone`.
 * `endMinute < startMinute` denotes a window that wraps past midnight (e.g.
 * 23:00–02:00). `weekdays` (0=Sunday … 6=Saturday) optionally restricts the
 * window to specific days; omitted means every day.
 */
export const timeOfDayConditionSchema = z
  .object({
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
    // An unknown zone makes Intl.DateTimeFormat throw at evaluation time, which
    // the engine treats as "no match" — so reject it here, at save time.
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isKnownTimeZone, 'unknown IANA timezone')
      .default('UTC'),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .strict();
export type TimeOfDayCondition = z.infer<typeof timeOfDayConditionSchema>;

export const playerFlagConditionSchema = z
  .object({
    flag: z.string().trim().min(1).max(64),
    present: z.boolean().default(true),
  })
  .strict();
export type PlayerFlagCondition = z.infer<typeof playerFlagConditionSchema>;

// ---------------------------------------------------------------------------
// Action config schemas
// ---------------------------------------------------------------------------

/**
 * An operator RCON command. `args` must carry exactly the count worker-rcon
 * requires for `command` ({@link RCON_OPERATOR_COMMAND_ARG_COUNTS}), each
 * non-blank: the worker refuses anything else after the run was already
 * recorded as executed.
 */
export const rconCommandActionSchema = z
  .object({
    command: rconOperatorCommandNameSchema,
    args: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = RCON_OPERATOR_COMMAND_ARG_COUNTS[value.command];
    if (value.args.length !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['args'],
        message: `${value.command} expects exactly ${expected} argument(s)`,
      });
    }
  });
export type RconCommandAction = z.infer<typeof rconCommandActionSchema>;

/** Kicks the player that triggered the rule (target resolved from the event). */
export const kickActionSchema = z
  .object({
    // Required: worker-rcon refuses `AdminKick` with a blank reason.
    reason: z.string().trim().min(1).max(RCON_TEXT_MAX),
  })
  .strict();
export type KickAction = z.infer<typeof kickActionSchema>;

/** Warns the player that triggered the rule (target resolved from the event). */
export const warnActionSchema = z
  .object({
    message: z.string().trim().min(1).max(RCON_TEXT_MAX),
  })
  .strict();
export type WarnAction = z.infer<typeof warnActionSchema>;

export const notifyAdminActionSchema = z
  .object({
    message: z.string().trim().min(1).max(512),
    channels: z.array(z.enum(AUTOMATION_NOTIFY_CHANNELS)).max(2).default([]),
  })
  .strict();
export type NotifyAdminAction = z.infer<typeof notifyAdminActionSchema>;

// ---------------------------------------------------------------------------
// Discriminated parsers
// ---------------------------------------------------------------------------

/** Parsed config shape per `condition_type`; the parser below returns the entry for its `type`. */
export interface AutomationConditionConfigs {
  chat_keyword: ChatKeywordCondition;
  player_count: PlayerCountCondition;
  time_of_day: TimeOfDayCondition;
  player_flag: PlayerFlagCondition;
}

/** Parsed config shape per `action_type`; the parser below returns the entry for its `type`. */
export interface AutomationActionConfigs {
  rcon_command: RconCommandAction;
  kick: KickAction;
  warn: WarnAction;
  notify_admin: NotifyAdminAction;
}

// Typing each table entry with its config shape makes swapping two keys a compile error.
const CONDITION_SCHEMAS: {
  [T in AutomationConditionType]: z.ZodType<AutomationConditionConfigs[T], z.ZodTypeDef, unknown>;
} = {
  chat_keyword: chatKeywordConditionSchema,
  player_count: playerCountConditionSchema,
  time_of_day: timeOfDayConditionSchema,
  player_flag: playerFlagConditionSchema,
};

const ACTION_SCHEMAS: {
  [T in AutomationActionType]: z.ZodType<AutomationActionConfigs[T], z.ZodTypeDef, unknown>;
} = {
  rcon_command: rconCommandActionSchema,
  kick: kickActionSchema,
  warn: warnActionSchema,
  notify_admin: notifyAdminActionSchema,
};

/**
 * Validates a raw `condition` jsonb against the schema for its `condition_type`.
 * The parsed data is typed by `type`, so callers that narrow `type` need no casts.
 */
export function parseAutomationCondition<T extends AutomationConditionType>(
  type: T,
  raw: unknown,
): z.SafeParseReturnType<unknown, AutomationConditionConfigs[T]> {
  return CONDITION_SCHEMAS[type].safeParse(raw);
}

/**
 * Validates a raw `action` jsonb against the schema for its `action_type`.
 * The parsed data is typed by `type`, so callers that narrow `type` need no casts.
 */
export function parseAutomationAction<T extends AutomationActionType>(
  type: T,
  raw: unknown,
): z.SafeParseReturnType<unknown, AutomationActionConfigs[T]> {
  return ACTION_SCHEMAS[type].safeParse(raw);
}
