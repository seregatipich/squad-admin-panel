import { playerDiscordLinks, players, roles, servers } from '@squad/db/schema';
import { and, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import {
  buildPlayerCardContent,
  buildStatusContent,
  type StatusSnapshot,
  verifyInteractionSignature,
} from '../lib/discord-interactions.js';
import { loadUserPermissions } from '../lib/rbac.js';
import { containsPattern } from '../lib/sql-like.js';

/**
 * DISCORD-6 (#153): Discord's HTTP interactions transport.
 *
 * Discord POSTs slash commands here and disables the endpoint outright if the
 * Ed25519 signature is not verified, so the raw request bytes must survive to
 * the handler — re-serialising the parsed JSON changes them and every signature
 * fails. The content-type parser below keeps the string, and Fastify's plugin
 * encapsulation keeps that override scoped to this route.
 *
 * Every answer is ephemeral (`flags: 64`): a command is addressed to the caller
 * and its output can name players and admins.
 */

const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const EPHEMERAL = 64;

const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;

/**
 * Largest accepted distance between `X-Signature-Timestamp` and now (#141).
 * The signature covers the timestamp, so bounding it stops a captured request
 * from being replayed indefinitely.
 */
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

interface InteractionOption {
  name?: string;
  value?: unknown;
}

interface InteractionBody {
  type?: number;
  data?: { name?: string; options?: InteractionOption[] };
  member?: { user?: { id?: string; username?: string } };
  user?: { id?: string; username?: string };
}

/** What this plugin's JSON content-type parser hands the route. */
interface ParsedInteraction {
  raw: string;
  parsed: InteractionBody;
}

function isParsedInteraction(value: unknown): value is ParsedInteraction {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { raw?: unknown }).raw === 'string' &&
    typeof (value as { parsed?: unknown }).parsed === 'object'
  );
}

/** True when `timestamp` is a unix-seconds value within the replay window. */
function isFreshTimestamp(timestamp: string, nowMs: number): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(nowMs / 1000 - Number(timestamp)) <= SIGNATURE_MAX_AGE_SECONDS;
}

function ephemeral(content: string) {
  return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL } };
}

function optionValue(body: InteractionBody, name: string): string | null {
  const found = body.data?.options?.find((o) => o?.name === name);
  return typeof found?.value === 'string' || typeof found?.value === 'number'
    ? String(found.value)
    : null;
}

const discordInteractionsRoutes: FastifyPluginAsync = async (app) => {
  // Scoped to this plugin: keeps the raw body for signature verification without
  // changing how the rest of the API parses JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const parsed: ParsedInteraction = {
        raw: String(body),
        parsed: JSON.parse(String(body)) as InteractionBody,
      };
      done(null, parsed);
    } catch {
      const unparsable: ParsedInteraction = { raw: String(body), parsed: {} };
      done(null, unparsable);
    }
  });

  app.post(
    '/api/v1/integrations/discord/interactions',
    { config: { audit: 'manual', public: true } },
    async (req, reply) => {
      const publicKeyHex = app.config.DISCORD_PUBLIC_KEY;
      if (!publicKeyHex) {
        reply.code(503);
        return { error: 'discord_interactions_not_configured' };
      }

      const rawBody = isParsedInteraction(req.body) ? req.body.raw : '';
      const body: InteractionBody = isParsedInteraction(req.body) ? req.body.parsed : {};

      const signature = req.headers['x-signature-ed25519'];
      const timestamp = req.headers['x-signature-timestamp'];
      if (typeof signature !== 'string' || typeof timestamp !== 'string') {
        reply.code(401);
        return { error: 'invalid_signature' };
      }
      if (
        !verifyInteractionSignature({ publicKeyHex, signatureHex: signature, timestamp, rawBody })
      ) {
        reply.code(401);
        return { error: 'invalid_signature' };
      }
      if (!isFreshTimestamp(timestamp, Date.now())) {
        reply.code(401);
        return { error: 'stale_timestamp' };
      }

      if (body.type === INTERACTION_PING) return { type: PONG };
      if (body.type !== INTERACTION_APPLICATION_COMMAND)
        return ephemeral('Неизвестный тип запроса.');

      const discordUserId = body.member?.user?.id ?? body.user?.id ?? null;
      if (!discordUserId) return ephemeral('Не удалось определить Discord-аккаунт.');

      const [link] = await app.db
        .select({ playerId: playerDiscordLinks.playerId })
        .from(playerDiscordLinks)
        .where(eq(playerDiscordLinks.discordUserId, discordUserId))
        .limit(1);
      if (!link) {
        return ephemeral('Аккаунт не привязан — привяжите Discord на своей странице в панели.');
      }

      // Same gate as a panel session: loadUserPermissions ignores a role whose
      // role_expires_at has passed even before the role-expirer tick strips it.
      const actorPermissions = await loadUserPermissions(app.db, link.playerId);
      if (!actorPermissions.panelAccess) {
        return ephemeral('У вашей роли нет доступа к панели.');
      }

      const auditActor: AuditActor = { kind: 'steam', playerId: link.playerId, tokenId: null };
      const name = body.data?.name ?? '';

      const audit = async (actionType: string) => {
        await writeAuditEntry(app.db, {
          actor: auditActor,
          actorIp: req.ip ?? null,
          actionType,
          targetType: 'discord_command',
          targetId: null,
          context: { request_id: req.id, command: name },
          statusCode: 200,
        });
      };

      if (name === 'status') {
        const rows = await app.db
          .select({ id: servers.id, displayName: servers.displayName })
          .from(servers)
          .where(isNull(servers.deletedAt));
        const lines = await Promise.all(
          rows.map(async (s) => {
            const raw = await app.redis.get(`rcon:status:${s.id}`);
            let status: StatusSnapshot | null = null;
            if (raw) {
              try {
                status = JSON.parse(raw) as StatusSnapshot;
              } catch {
                status = null;
              }
            }
            return { displayName: s.displayName, status };
          }),
        );
        await audit('discord.command.status');
        return ephemeral(buildStatusContent(lines));
      }

      if (name === 'player') {
        const query = (optionValue(body, 'query') ?? '').trim();
        if (!query) return ephemeral('Укажите имя или SteamID64.');
        const digits = /^\d{17}$/.test(query);
        const [found] = digits
          ? await app.db
              .select({
                id: players.id,
                canonicalName: players.canonicalName,
                steamId64: players.steamId64,
              })
              .from(players)
              .where(eq(players.steamId64, BigInt(query)))
              .limit(1)
          : await app.db
              .select({
                id: players.id,
                canonicalName: players.canonicalName,
                steamId64: players.steamId64,
              })
              .from(players)
              .where(ilike(players.canonicalName, containsPattern(query)))
              .limit(1);
        await audit('discord.command.player');
        if (!found) return ephemeral('Игрок не найден.');
        return ephemeral(
          buildPlayerCardContent(
            {
              id: found.id,
              canonical_name: found.canonicalName,
              steam_id64: found.steamId64 ? String(found.steamId64) : null,
            },
            app.config.PANEL_PUBLIC_URL,
          ),
        );
      }

      if (name === 'online-admins') {
        const rows = await app.db
          .select({ id: servers.id })
          .from(servers)
          .where(isNull(servers.deletedAt));
        const rosterNames = new Map<string, string>();
        const rosters =
          rows.length > 0 ? await app.redis.mget(rows.map((s2) => `rcon:roster:${s2.id}`)) : [];
        for (const raw of rosters) {
          if (!raw) continue;
          try {
            const roster = JSON.parse(raw) as {
              players?: { steam_id64?: string; name?: string }[];
            };
            for (const p of roster.players ?? []) {
              if (p?.steam_id64 && /^\d{17}$/.test(p.steam_id64)) {
                rosterNames.set(p.steam_id64, p.name ?? p.steam_id64);
              }
            }
          } catch {
            // A malformed roster snapshot is not worth failing the command over.
          }
        }
        await audit('discord.command.online_admins');
        if (rosterNames.size === 0) return ephemeral('Админов онлайн нет.');
        // innerJoin on roles + panelAccess: only roster players whose role grants
        // panel access count as admins, so a plain player on the server is not listed.
        // A lapsed role_expires_at counts as no role, matching lib/rbac.ts.
        const admins = await app.db
          .select({ steamId64: players.steamId64, panelAccess: roles.panelAccess })
          .from(players)
          .innerJoin(
            roles,
            and(
              eq(roles.id, players.roleId),
              or(isNull(players.roleExpiresAt), gt(players.roleExpiresAt, sql`now()`)),
            ),
          )
          .where(
            inArray(
              players.steamId64,
              [...rosterNames.keys()].map((k) => BigInt(k)),
            ),
          );
        const finalNames = admins
          .filter((r) => r.panelAccess && r.steamId64 !== null)
          .map((r) => rosterNames.get(String(r.steamId64)) as string);
        if (finalNames.length === 0) return ephemeral('Админов онлайн нет.');
        return ephemeral(`Админы онлайн:\n${finalNames.map((n) => `• ${n}`).join('\n')}`);
      }

      return ephemeral('Неизвестная команда.');
    },
  );
};

export default discordInteractionsRoutes;
