/**
 * In-game chat commands (AUTO-4, #75).
 *
 * Recognizes `!stats`, `!rules`, and `!report` on a {@link ParsedChat} line,
 * answers the requesting player over RCON (an `AdminWarn` enqueued to
 * worker-rcon's command stream), and appends one history row to
 * `chat_command_invocations`.
 *
 * `!report` is special: REPORT-1 already owns the report record. The ingestor
 * fires `onReport` for the same log line
 * (`apps/workers/log-ingest/src/parser/ingest.ts`), and
 * `apps/workers/log-ingest/src/report/store.ts` writes the `player_reports`
 * row + `player_report` event (which DISCORD-2 turns into a notification). So
 * this handler must NOT create a second report row or event for `!report` — it
 * only logs the AUTO-4 invocation and sends an acknowledgement.
 *
 * The per-server `chat_commands_enabled` toggle lets operators disable
 * panel-owned chat commands where an RNSquadJS sidecar runs its own
 * `chatCommands` (see the RNSquadJS migration design), avoiding double replies.
 */
import {
  type ChatCommandName,
  type ChatCommandResponseSource,
  chatCommandInvocations,
  type DatabaseClient,
  playerStatPeriods,
  serverSettings,
} from '@squad/db';
import {
  type RconOperatorCommandName,
  rconCommandRequestSchema,
  rconCommandStream,
} from '@squad/shared-types';
import { and, eq, isNull, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ParsedChat } from '../parser/chat.js';
import { resolvePlayerId } from './store.js';

const RCON_STREAM_MAXLEN = 500;

/** Minimal redis surface: enqueue an RCON command onto worker-rcon's stream. */
export interface RconEnqueue {
  xadd(key: string, ...args: (string | number)[]): Promise<unknown>;
}

export interface ChatCommandOutcome {
  invocationId: string;
  command: ChatCommandName;
  playerId: string | null;
  responded: boolean;
  responseSource: ChatCommandResponseSource;
}

const COMMAND_PATTERN = /^!(?<name>stats|rules|report)\b\s*(?<args>.*)$/i;

/**
 * Enqueues an operator RCON command onto worker-rcon's per-server command
 * stream. Mirrors `apps/workers/scheduler/src/deps.ts`'s `sendRconCommand`
 * (the API-side helper in `apps/api/src/lib/rcon-worker-command.ts` cannot be
 * imported from a worker package).
 */
export async function sendRconCommand(
  redis: RconEnqueue,
  input: { serverId: string; command: RconOperatorCommandName; args: string[] },
): Promise<void> {
  const request = rconCommandRequestSchema.parse({
    request_id: uuidv7(),
    command: input.command,
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

/** The player's EOS id, SteamID64, or in-game name — whatever AdminWarn can target. */
function warnTarget(chat: ParsedChat): string {
  return chat.eosId ?? chat.steamId64 ?? chat.playerName;
}

async function statsMessage(
  db: DatabaseClient,
  serverId: string,
  playerId: string,
): Promise<string> {
  const rows = await db
    .select({
      serverId: playerStatPeriods.serverId,
      kills: playerStatPeriods.kills,
      deaths: playerStatPeriods.deaths,
      teamkills: playerStatPeriods.teamkills,
      revives: playerStatPeriods.revives,
      matchesPlayed: playerStatPeriods.matchesPlayed,
    })
    .from(playerStatPeriods)
    .where(
      and(
        eq(playerStatPeriods.playerId, playerId),
        eq(playerStatPeriods.periodType, 'alltime'),
        or(eq(playerStatPeriods.serverId, serverId), isNull(playerStatPeriods.serverId)),
      ),
    );
  if (rows.length === 0) return 'Статистика пока не записана.';
  const row = rows.find((r) => r.serverId === serverId) ?? rows.find((r) => r.serverId === null);
  if (!row) return 'Статистика пока не записана.';
  const kd = row.deaths > 0 ? (row.kills / row.deaths).toFixed(2) : String(row.kills);
  return `Статистика: убийства ${row.kills}, смерти ${row.deaths}, K/D ${kd}, тимкиллы ${row.teamkills}, ревайвы ${row.revives}, матчи ${row.matchesPlayed}.`;
}

/**
 * Handles one chat line as a potential AUTO-4 command. Returns `null` when the
 * line is not a recognized command or when chat commands are disabled for the
 * server (no invocation is recorded and no RCON reply is sent in that case);
 * otherwise records the invocation and returns its outcome.
 */
export async function handleChatCommand(
  db: DatabaseClient,
  redis: RconEnqueue | null,
  { serverId, chat }: { serverId: string; chat: ParsedChat },
): Promise<ChatCommandOutcome | null> {
  const match = COMMAND_PATTERN.exec(chat.message);
  if (!match?.groups?.name) return null;
  const command = match.groups.name.toLowerCase() as ChatCommandName;
  const args = (match.groups.args ?? '').trim();

  const settings = await db
    .select({
      enabled: serverSettings.chatCommandsEnabled,
      rulesText: serverSettings.rulesText,
    })
    .from(serverSettings)
    .where(eq(serverSettings.serverId, serverId))
    .limit(1);
  if (settings[0]?.enabled === false) return null;
  const rulesText = settings[0]?.rulesText ?? null;

  const playerId = await resolvePlayerId(db, chat);

  let message: string;
  switch (command) {
    case 'stats':
      message = playerId
        ? await statsMessage(db, serverId, playerId)
        : 'Статистика пока не записана.';
      break;
    case 'rules':
      message = rulesText?.trim() ? rulesText : 'Правила не настроены.';
      break;
    default:
      // `!report`: REPORT-1 owns the report record (onReport path). AUTO-4 only
      // acknowledges the requester; it must not store a second report.
      message = 'Жалоба принята. Администрация уведомлена.';
      break;
  }

  let responded = false;
  let responseSource: ChatCommandResponseSource = 'none';
  if (redis) {
    await sendRconCommand(redis, {
      serverId,
      command: 'AdminWarn',
      args: [warnTarget(chat), message],
    });
    responded = true;
    responseSource = 'rcon_warn';
  }

  const invocationId = uuidv7();
  await db.insert(chatCommandInvocations).values({
    id: invocationId,
    serverId,
    playerId,
    command,
    args,
    responded,
    responseSource,
  });

  return { invocationId, command, playerId, responded, responseSource };
}
