import { z } from 'zod';

export const RCON_COMMAND_STREAM_PREFIX = 'rcon:commands:';
export const RCON_COMMAND_GROUP = 'worker-rcon:commands:v1';
export const RCON_COMMAND_RESULT_PREFIX = 'rcon:command-result:';
/**
 * Dedup marker kept apart from the result key: the API deletes
 * `rcon:command-result:<id>` as soon as it reads it, so that key alone cannot
 * tell a later `XAUTOCLAIM` redelivery (or a caller retry reusing the same
 * `request_id`) that the command already ran. Written once alongside every
 * result with a long TTL the API never touches (#1293).
 */
export const RCON_COMMAND_DONE_PREFIX = 'rcon:command-done:';
/**
 * Optional stream-entry field (next to `request`) holding an ISO-8601 instant
 * after which worker-rcon must not execute the command: it acknowledges the
 * entry and stores an `expired` result instead (#36). A producer that stops
 * waiting for the result sets it to the end of its wait, so a command the
 * caller already reported as timed out cannot run later unaudited, or twice
 * after an operator retry. It lives outside the strict `request` JSON so a
 * worker that predates it still parses the request.
 */
export const RCON_COMMAND_DEADLINE_FIELD = 'deadline_at';
/** `error` of the result worker-rcon stores for a request past its deadline. */
export const RCON_COMMAND_EXPIRED_ERROR = 'expired';

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

/** Upper bounds keeping a queued request within one RCON packet (Source RCON caps a body near 4 KiB). */
export const RCON_ARG_MAX_LENGTH = 1024;
export const RCON_ARGS_MAX_COUNT = 8;

export const rconCommandRequestSchema = z
  .object({
    request_id: z.string().min(1).max(128),
    command: rconOperatorCommandNameSchema,
    args: z.array(z.string().max(RCON_ARG_MAX_LENGTH)).max(RCON_ARGS_MAX_COUNT).default([]),
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

export function rconCommandDoneKey(requestId: string): string {
  return `${RCON_COMMAND_DONE_PREFIX}${requestId}`;
}
