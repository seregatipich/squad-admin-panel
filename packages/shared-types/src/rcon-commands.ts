import { z } from 'zod';

export const RCON_COMMAND_STREAM_PREFIX = 'rcon:commands:';
export const RCON_COMMAND_GROUP = 'worker-rcon:commands:v1';
export const RCON_COMMAND_RESULT_PREFIX = 'rcon:command-result:';

export const RCON_OPERATOR_COMMANDS = [
  'AdminBroadcast',
  'AdminEndMatch',
  'AdminKick',
  'AdminReloadServerConfig',
  'AdminWarn',
] as const;

export const rconOperatorCommandNameSchema = z.enum(RCON_OPERATOR_COMMANDS);
export type RconOperatorCommandName = z.infer<typeof rconOperatorCommandNameSchema>;

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
