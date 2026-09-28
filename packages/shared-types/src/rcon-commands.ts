import { z } from 'zod';

export const RCON_COMMAND_STREAM_PREFIX = 'rcon:commands:';
export const RCON_COMMAND_GROUP = 'worker-rcon:commands:v1';
export const RCON_COMMAND_RESULT_PREFIX = 'rcon:command-result:';

export const RCON_OPERATOR_COMMANDS = [
  'AdminBan',
  'AdminBroadcast',
  'AdminChangeLayer',
  'AdminEndMatch',
  'AdminKick',
  'AdminReloadServerConfig',
  'AdminSetNextLayer',
  'AdminWarn',
] as const;

export const rconOperatorCommandNameSchema = z.enum(RCON_OPERATOR_COMMANDS);
export type RconOperatorCommandName = z.infer<typeof rconOperatorCommandNameSchema>;

/**
 * Exact argument count worker-rcon's `buildOperatorCommand`
 * (apps/workers/rcon/src/commands.ts) demands for each operator command; any
 * other count is rejected there. Producers that persist a command for later
 * dispatch (automation rules) validate against this at save time so a rule can
 * never enqueue a command the worker is bound to refuse.
 */
export const RCON_OPERATOR_COMMAND_ARG_COUNTS: Readonly<Record<RconOperatorCommandName, number>> = {
  AdminBan: 3,
  AdminBroadcast: 1,
  AdminChangeLayer: 1,
  AdminEndMatch: 0,
  AdminKick: 2,
  AdminReloadServerConfig: 0,
  AdminSetNextLayer: 1,
  AdminWarn: 2,
};

export const rconCommandRequestSchema = z
  .object({
    request_id: z.string().min(1).max(128),
    command: rconOperatorCommandNameSchema,
    args: z.array(z.string()).default([]),
    actor_player_id: z.string().min(1).max(64).nullable().optional(),
    enqueued_at: z.string().datetime().optional(),
  })
  .strict();
export type RconCommandRequest = z.infer<typeof rconCommandRequestSchema>;

export const rconCommandResultSchema = z
  .object({
    ok: z.boolean(),
    server_id: z.string().min(1),
    request_id: z.string().min(1).max(128),
    command: rconOperatorCommandNameSchema.optional(),
    response: z.string().optional(),
    error: z.string().optional(),
    completed_at: z.string().datetime(),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();
export type RconCommandResult = z.infer<typeof rconCommandResultSchema>;

export function rconCommandStream(serverId: string): string {
  return `${RCON_COMMAND_STREAM_PREFIX}${serverId}`;
}

export function rconCommandResultKey(requestId: string): string {
  return `${RCON_COMMAND_RESULT_PREFIX}${requestId}`;
}
