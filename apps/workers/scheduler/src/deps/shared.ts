import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';
import {
  type RconOperatorCommandName,
  rconCommandRequestSchema,
  rconCommandStream,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type { SendRconCommandInput } from '../due-occurrence.js';

const RCON_STREAM_MAXLEN = 500;

export async function isDepotUpdating(redis: Pick<Redis, 'get'>): Promise<boolean> {
  return (await redis.get('depot:updating')) !== null;
}

/**
 * Enqueues an operator RCON command onto worker-rcon's command stream. The
 * actual RCON round-trip and result polling happen in `worker-rcon`
 * (`apps/workers/rcon`) — mirrors `apps/workers/clan-guard/src/deps.ts`'s
 * `sendRconCommand`, since the API-side helper
 * (`apps/api/src/lib/rcon-worker-command.ts`) cannot be imported from a
 * worker package. `requestId` lets an idempotent caller (the GAME-1 map-vote
 * tick) pin a deterministic request id; omitted, a fresh uuidv7 is used.
 */
export async function sendRconCommand(
  redis: Pick<Redis, 'xadd'>,
  input: SendRconCommandInput,
  requestId?: string,
): Promise<void> {
  const request = rconCommandRequestSchema.parse({
    request_id: requestId ?? uuidv7(),
    command: input.command as RconOperatorCommandName,
    args: input.args,
    actor_player_id: null,
    enqueued_at: new Date().toISOString(),
  });
  await redis.xadd(
    rconCommandStream(input.serverId),
    'MAXLEN',
    '~',
    String(RCON_STREAM_MAXLEN),
    '*',
    'request',
    JSON.stringify(request),
  );
}

/** Fields shared by every system-actor `audit_log` row this worker writes. */
export interface SystemAuditEntry {
  actor: { kind: 'system'; label: string };
  actionType: string;
  targetType: string;
  targetId: string;
  context: Record<string, unknown>;
}

/**
 * Appends one `audit_log` row for a scheduler action. `rowHash` is a
 * placeholder: the `audit_log_append` trigger computes the real hash chain.
 */
export async function writeSystemAuditEntry(
  db: Pick<DatabaseClient, 'insert'>,
  entry: SystemAuditEntry,
): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: entry.actor.kind,
    actorPlayerId: null,
    actorTokenId: null,
    actorSystemLabel: entry.actor.label,
    actorIp: null,
    actionType: entry.actionType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    beforeSnapshot: null,
    afterSnapshot: null,
    context: entry.context,
    statusCode: null,
    rowHash: Buffer.from([]),
  });
}
