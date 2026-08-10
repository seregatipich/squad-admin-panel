import type { Logger } from 'pino';

/**
 * The three Discord REST calls the panel-role → Discord-role sync needs
 * (DISCORD-5, #152), spoken over raw `fetch` like the rest of this repository
 * (see `apps/api/src/lib/discord-oauth.ts`); no Discord library is used.
 *
 * Endpoints and semantics follow the current Discord documentation
 * (https://docs.discord.com/developers/resources/guild):
 *   GET    /guilds/{guild}/members/{user}
 *   PUT    /guilds/{guild}/members/{user}/roles/{role}
 *   DELETE /guilds/{guild}/members/{user}/roles/{role}
 * All three authenticate with the `Bot <token>` scheme and all three require
 * the bot to hold **Manage Roles** and to sit above the target role in the
 * guild's role hierarchy; without either, Discord answers `403` with error
 * code `50013` (`Missing Permissions`).
 */
export const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Hard ceiling on consecutive 429 retries for a single call. */
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1000;

export interface DiscordRestDeps {
  guildId: string;
  botToken: string;
  /** Injected so tests can substitute a fake without touching the network. */
  fetchImpl: typeof fetch;
  /** Injected so retry-delay tests don't have to wait in real time. */
  sleep: (ms: number) => Promise<void>;
  log: Logger;
}

export type DiscordFailureReason =
  | 'missing_permissions'
  | 'rate_limited'
  | 'http_error'
  | 'network_error';

export interface DiscordFailure {
  reason: DiscordFailureReason;
  /** Operator-facing Russian text; surfaced verbatim by the settings UI. */
  message: string;
}

export type RoleCallResult = { ok: true } | { ok: false; failure: DiscordFailure };

export function missingPermissionsFailure(): DiscordFailure {
  return {
    reason: 'missing_permissions',
    message: 'У бота нет права Manage Roles в Discord-гильдии.',
  };
}

/** Reads Discord's rate-limit wait: `Retry-After` header (seconds) first, then the JSON `retry_after` field. */
async function readRetryAfterMs(res: Response): Promise<number> {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  try {
    const body = (await res.clone().json()) as { retry_after?: unknown };
    if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) {
      return Math.max(0, body.retry_after) * 1000;
    }
  } catch {
    // no/invalid JSON body — fall through to the default wait
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

function memberUrl(deps: DiscordRestDeps, discordUserId: string): string {
  return `${DISCORD_API_BASE}/guilds/${deps.guildId}/members/${discordUserId}`;
}

function authHeaders(deps: DiscordRestDeps): Record<string, string> {
  return { authorization: `Bot ${deps.botToken}`, 'content-type': 'application/json' };
}

/**
 * Issues one role mutation, retrying only on 429 for the delay Discord asks
 * for. Never throws — callers get a typed failure instead, so one member's
 * problem never aborts a reconcile sweep.
 */
async function roleCall(
  deps: DiscordRestDeps,
  method: 'PUT' | 'DELETE',
  discordUserId: string,
  discordRoleId: string,
): Promise<RoleCallResult> {
  const url = `${memberUrl(deps, discordUserId)}/roles/${discordRoleId}`;
  let rateLimitRetries = 0;
  for (;;) {
    let res: Response;
    try {
      res = await deps.fetchImpl(url, { method, headers: authHeaders(deps) });
    } catch (err) {
      return {
        ok: false,
        failure: {
          reason: 'network_error',
          message: `Discord недоступен: ${(err as Error).message}`,
        },
      };
    }

    if (res.status === 429) {
      rateLimitRetries++;
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        return {
          ok: false,
          failure: {
            reason: 'rate_limited',
            message: 'Discord ограничивает частоту запросов — синхронизация отложена.',
          },
        };
      }
      await deps.sleep(await readRetryAfterMs(res));
      continue;
    }

    if (res.ok) return { ok: true };

    // Every 403 on these routes is the same operator problem: the bot lacks
    // Manage Roles, or sits below the target role in the guild hierarchy.
    if (res.status === 403) {
      deps.log.error(
        { method, discordUserId, discordRoleId },
        'discord rejected a role change (Missing Permissions)',
      );
      return { ok: false, failure: missingPermissionsFailure() };
    }
    return {
      ok: false,
      failure: { reason: 'http_error', message: `Discord вернул ${res.status}` },
    };
  }
}

export function addGuildMemberRole(
  deps: DiscordRestDeps,
  discordUserId: string,
  discordRoleId: string,
): Promise<RoleCallResult> {
  return roleCall(deps, 'PUT', discordUserId, discordRoleId);
}

export function removeGuildMemberRole(
  deps: DiscordRestDeps,
  discordUserId: string,
  discordRoleId: string,
): Promise<RoleCallResult> {
  return roleCall(deps, 'DELETE', discordUserId, discordRoleId);
}

/**
 * Renames one channel (DISCORD-6, #153).
 *
 * `PATCH /channels/{id}` carries its own, unusually harsh bucket: Discord
 * allows **two** channel updates per ten minutes per channel, and going over it
 * costs a multi-minute lockout rather than the usual sub-second `Retry-After`.
 * The caller (`status-channel.ts`) is therefore responsible for the budget; the
 * 429 handling here is only a backstop for a bucket shared with another client.
 */
export async function patchChannelName(
  deps: DiscordRestDeps,
  channelId: string,
  name: string,
): Promise<RoleCallResult> {
  const url = `${DISCORD_API_BASE}/channels/${channelId}`;
  let rateLimitRetries = 0;
  for (;;) {
    let res: Response;
    try {
      res = await deps.fetchImpl(url, {
        method: 'PATCH',
        headers: authHeaders(deps),
        body: JSON.stringify({ name }),
      });
    } catch (err) {
      return {
        ok: false,
        failure: {
          reason: 'network_error',
          message: `Discord недоступен: ${(err as Error).message}`,
        },
      };
    }

    if (res.status === 429) {
      rateLimitRetries++;
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        return {
          ok: false,
          failure: {
            reason: 'rate_limited',
            message: 'Discord ограничивает переименование канала — попробуем на следующем тике.',
          },
        };
      }
      await deps.sleep(await readRetryAfterMs(res));
      continue;
    }

    if (res.ok) return { ok: true };

    if (res.status === 403) {
      deps.log.error({ channelId }, 'discord rejected a channel rename (Missing Permissions)');
      return {
        ok: false,
        failure: {
          reason: 'missing_permissions',
          message: 'У бота нет права Manage Channels для статус-канала.',
        },
      };
    }
    return {
      ok: false,
      failure: { reason: 'http_error', message: `Discord вернул ${res.status}` },
    };
  }
}

export type GuildMemberResult =
  | { ok: true; roles: string[] }
  | { ok: false; notAMember: true }
  | { ok: false; notAMember: false; failure: DiscordFailure };

/**
 * Fetches one guild member's current role ids.
 *
 * Reads a single member rather than listing the guild deliberately:
 * `GET /guilds/{id}/members` needs the privileged `GUILD_MEMBERS` intent, while
 * the per-member lookup does not — and the sync only ever cares about players
 * that have a `player_discord_links` row anyway.
 *
 * A `404` means the Discord account is simply not in the guild, which is a
 * normal state (the player linked their account but never joined the server),
 * so it is reported as `notAMember` rather than as an error.
 */
export async function fetchGuildMemberRoles(
  deps: DiscordRestDeps,
  discordUserId: string,
): Promise<GuildMemberResult> {
  let res: Response;
  try {
    res = await deps.fetchImpl(memberUrl(deps, discordUserId), {
      method: 'GET',
      headers: authHeaders(deps),
    });
  } catch (err) {
    return {
      ok: false,
      notAMember: false,
      failure: {
        reason: 'network_error',
        message: `Discord недоступен: ${(err as Error).message}`,
      },
    };
  }

  if (res.status === 404) return { ok: false, notAMember: true };
  if (res.status === 403) {
    return { ok: false, notAMember: false, failure: missingPermissionsFailure() };
  }
  if (!res.ok) {
    return {
      ok: false,
      notAMember: false,
      failure: { reason: 'http_error', message: `Discord вернул ${res.status}` },
    };
  }

  try {
    const body = (await res.json()) as { roles?: unknown };
    const roles = Array.isArray(body.roles) ? body.roles.filter((r) => typeof r === 'string') : [];
    return { ok: true, roles: roles as string[] };
  } catch (err) {
    return {
      ok: false,
      notAMember: false,
      failure: {
        reason: 'http_error',
        message: `Discord вернул нечитаемый ответ: ${(err as Error).message}`,
      },
    };
  }
}
