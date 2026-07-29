import { playerDiscordLinks, players, roles, servers } from '@squad/db/schema';
import { eq, ilike, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import {
  buildPlayerCardContent,
  buildStatusContent,
  type StatusSnapshot,
  verifyInteractionSignature,
} from '../lib/discord-interactions.js';

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
      done(null, { raw: String(body), parsed: JSON.parse(String(body)) as InteractionBody });
    } catch {
      done(null, { raw: String(body), parsed: {} as InteractionBody });
    }
  });

  app.post(
    '/api/v1/integrations/discord/interactions',
    { config: { audit: false, public: true } },
    async (req, reply) => {
      const publicKeyHex = (app.config as { DISCORD_PUBLIC_KEY?: string }).DISCORD_PUBLIC_KEY;
      if (!publicKeyHex) {
        reply.code(503);
        return { error: 'discord_interactions_not_configured' };
      }

      const payload = req.body as { raw?: string; parsed?: InteractionBody } | undefined;
      const rawBody = payload?.raw ?? '';
      const body = payload?.parsed ?? {};

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

      const [actor] = await app.db
        .select({ id: players.id, panelAccess: roles.panelAccess })
        .from(players)
        .leftJoin(roles, eq(roles.id, players.roleId))
        .where(eq(players.id, link.playerId))
        .limit(1);
      if (!actor?.panelAccess) {
        return ephemeral('У вашей роли нет доступа к панели.');
      }

      const auditActor: AuditActor = { kind: 'steam', playerId: actor.id, tokenId: null };
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
              .where(ilike(players.canonicalName, `%${query}%`))
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
            (app.config as { PANEL_PUBLIC_URL?: string }).PANEL_PUBLIC_URL ?? '',
          ),
        );
      }

      if (name === 'online-admins') {
        const rows = await app.db
          .select({ id: servers.id })
          .from(servers)
          .where(isNull(servers.deletedAt));
        const rosterNames = new Map<string, string>();
        for (const s2 of rows) {
          const raw = await app.redis.get(`rcon:roster:${s2.id}`);
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
        const admins = await app.db
          .select({ steamId64: players.steamId64, panelAccess: roles.panelAccess })
          .from(players)
          .innerJoin(roles, eq(roles.id, players.roleId))
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
