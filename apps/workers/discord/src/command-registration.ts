import { DISCORD_API_BASE, type DiscordRestDeps } from './discord-rest.js';

/**
 * Application-command registration (DISCORD-6, #153).
 *
 * Discord needs the command list declared once through the REST API before a
 * `/status` ever reaches the interactions endpoint. `PUT
 * /applications/{id}/commands` is a full replace and is idempotent, so it is
 * safe to send on every worker boot — Discord treats an identical payload as a
 * no-op and does not reset the commands' ids.
 *
 * Guild-scoped registration is deliberately not used: it updates instantly but
 * would need the guild id threaded through, and global commands are the correct
 * shape for a panel that serves one community.
 *
 * Every command here is **read-only**. Moderation from Discord (ban/kick) is an
 * explicit non-goal of #153 — it stays in the panel UI, MOD-2 (#59).
 */

/** Discord `APPLICATION_COMMAND_OPTION_TYPE.STRING`. */
const OPTION_TYPE_STRING = 3;

export const DISCORD_COMMAND_DEFINITIONS = [
  {
    name: 'status',
    description: 'Текущая карта, онлайн и очередь серверов',
    options: [
      {
        type: OPTION_TYPE_STRING,
        name: 'server',
        description: 'Слаг или имя сервера (по умолчанию — все)',
        required: false,
      },
    ],
  },
  {
    name: 'player',
    description: 'Карточка игрока по нику или SteamID64',
    options: [
      {
        type: OPTION_TYPE_STRING,
        name: 'query',
        description: 'Ник или SteamID64',
        required: true,
      },
    ],
  },
  {
    name: 'online-admins',
    description: 'Админы панели, находящиеся сейчас на серверах',
    options: [],
  },
] as const;

export type CommandRegistrationResult =
  | { ok: true; count: number }
  | { ok: false; status: number | null; message: string };

/**
 * Publishes the command list. Never throws — a worker must not crash-loop
 * because Discord is briefly unreachable or the token lost its `applications.commands` scope.
 */
export async function registerApplicationCommands(
  deps: DiscordRestDeps,
  applicationId: string,
): Promise<CommandRegistrationResult> {
  const url = `${DISCORD_API_BASE}/applications/${applicationId}/commands`;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      method: 'PUT',
      headers: { authorization: `Bot ${deps.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(DISCORD_COMMAND_DEFINITIONS),
    });
  } catch (err) {
    return { ok: false, status: null, message: `Discord недоступен: ${(err as Error).message}` };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `Discord отклонил регистрацию команд: ${res.status}`,
    };
  }
  return { ok: true, count: DISCORD_COMMAND_DEFINITIONS.length };
}
