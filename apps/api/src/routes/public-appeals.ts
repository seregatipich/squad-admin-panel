import { randomBytes } from 'node:crypto';
import { banAppeals, moderationActions, players } from '@squad/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { parseBanLengthToExpiry } from '../lib/banlist-publish.js';

const STEAM_ID64_RE = /^\d{17}$/;
const BODY_MIN = 20;
const BODY_MAX = 4000;
const CONTACT_MAX = 200;
const TOKEN_MIN = 16;
const TOKEN_MAX = 64;

/** Coarse per-IP throttle applied by `@fastify/rate-limit` on top of the daily caps. */
const PUBLIC_SUBMIT_RATE_MAX = 5;
const PUBLIC_STATUS_RATE_MAX = 60;

/**
 * Daily anti-abuse caps, counted in Redis. The portal is unauthenticated, so
 * these are the only thing standing between it and a scripted flood: one
 * budget per source address and a much tighter one per claimed SteamID64, so
 * a single address cannot bury one player's queue slot either.
 */
const IP_DAILY_MAX = 10;
const STEAM_DAILY_MAX = 3;
const DAY_SECONDS = 86_400;

/** Postgres unique_violation — the partial open-appeal unique index tripped. */
const PG_UNIQUE_VIOLATION = '23505';

const submitBody = z.object({
  steam_id64: z.string().regex(STEAM_ID64_RE),
  body: z.string().trim().min(BODY_MIN).max(BODY_MAX),
  contact: z.string().trim().max(CONTACT_MAX).optional(),
  moderation_action_id: z.string().uuid().optional(),
});

const tokenParams = z.object({ token: z.string().min(TOKEN_MIN).max(TOKEN_MAX) });

/**
 * Public, unauthenticated half of the ban-appeal portal (MOD-5, #62).
 *
 * A banned player has no panel session by definition, so both routes here are
 * anonymous; they follow the shape of the public whitelist-application portal
 * (`whitelist-applications.ts`): `config.audit: false` plus a declarative rate
 * limit, self-auditing through an explicit {@link writeAuditEntry} with a
 * `system`/`http-anonymous` actor (the `audit_log_actor_kind` check constraint
 * only accepts `steam` with an actor player or `system` with a label).
 *
 * Both routes are deliberately blind oracles. Submitting answers `201` for a
 * banned player, an unbanned player and a SteamID64 the panel has never seen
 * alike, so the portal cannot be walked to discover who is banned; the status
 * route projects only the five applicant-facing fields and answers a single
 * `404 appeal_not_found` for both an unknown and somebody else's token.
 */
const publicAppealsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Increments a daily Redis counter and reports whether it is now over
   * `max`. The TTL is set on the first hit of the window, so a failed Redis
   * `expire` cannot leave a permanently blocking key: `incr` returning 1 is
   * the only branch that (re-)arms it.
   */
  async function overDailyLimit(key: string, max: number): Promise<boolean> {
    const hits = await app.redis.incr(key).catch(() => 0);
    if (hits === 1) await app.redis.expire(key, DAY_SECONDS).catch(() => undefined);
    return hits > max;
  }

  /**
   * Best-effort resolution of the ban being appealed: the newest ban row for
   * this player that is neither reverted nor expired. Purely informational —
   * an appeal for a player with no active ban is still accepted, because
   * rejecting it would leak the player's ban state to an anonymous caller.
   */
  async function resolveActiveBanId(
    playerId: string,
    preferredId?: string,
  ): Promise<string | null> {
    const rows = await app.db
      .select({
        id: moderationActions.id,
        context: moderationActions.context,
        createdAt: moderationActions.createdAt,
      })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.playerId, playerId),
          eq(moderationActions.actionType, 'ban'),
          isNull(moderationActions.revertedAt),
        ),
      )
      .orderBy(desc(moderationActions.createdAt));

    const now = Date.now();
    const active = rows.filter((row) => {
      const context = (row.context ?? {}) as { ban_length?: unknown };
      const banLength = typeof context.ban_length === 'string' ? context.ban_length : null;
      const expiresAt = parseBanLengthToExpiry(banLength, row.createdAt);
      return expiresAt === null || expiresAt.getTime() > now;
    });

    if (preferredId && active.some((row) => row.id === preferredId)) return preferredId;
    return active[0]?.id ?? null;
  }

  fast.post(
    '/api/v1/public/appeals',
    {
      schema: { body: submitBody },
      config: {
        audit: false,
        public: true,
        rateLimit: { max: PUBLIC_SUBMIT_RATE_MAX, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const ip = req.ip ?? null;
      const steamId64 = BigInt(req.body.steam_id64);

      if (ip && (await overDailyLimit(`appeal-rl:ip:${ip}`, IP_DAILY_MAX))) {
        reply.code(429);
        return { error: 'rate_limited' };
      }
      if (await overDailyLimit(`appeal-rl:steam:${req.body.steam_id64}`, STEAM_DAILY_MAX)) {
        reply.code(429);
        return { error: 'rate_limited' };
      }

      const [player] = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.steamId64, steamId64))
        .limit(1);

      const moderationActionId = player
        ? await resolveActiveBanId(player.id, req.body.moderation_action_id)
        : null;

      const trackingToken = randomBytes(24).toString('base64url');

      let created: { id: string; number: number; status: string };
      try {
        const [inserted] = await app.db
          .insert(banAppeals)
          .values({
            playerId: player?.id ?? null,
            moderationActionId,
            steamId64,
            body: req.body.body,
            contact: req.body.contact?.trim() || null,
            status: 'pending',
            trackingToken,
            submitterIp: ip,
          })
          .returning({
            id: banAppeals.id,
            number: banAppeals.number,
            status: banAppeals.status,
          });
        if (!inserted) throw new Error('ban_appeals insert returned no row');
        created = { id: inserted.id, number: Number(inserted.number), status: inserted.status };
      } catch (err) {
        // drizzle wraps the driver error; the PG code may sit on the error or
        // its `.cause` depending on the failure path.
        const code =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code === PG_UNIQUE_VIOLATION) {
          reply.code(409);
          return { error: 'appeal_already_open' };
        }
        throw err;
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'system', label: 'http-anonymous' },
        actorIp: ip,
        actionType: 'appeal.create',
        targetType: 'ban_appeal',
        targetId: created.id,
        after: { number: created.number, status: created.status },
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url,
          steam_id64: req.body.steam_id64,
        },
        statusCode: 201,
      });

      app.liveBus.publish({
        type: 'appeal.created',
        ts: new Date().toISOString(),
        data: { appeal_id: created.id, number: created.number, status: created.status },
      });

      reply.code(201);
      return {
        id: created.id,
        number: created.number,
        status: created.status,
        tracking_token: trackingToken,
      };
    },
  );

  fast.get(
    '/api/v1/public/appeals/:token',
    {
      schema: { params: tokenParams },
      config: {
        audit: false,
        public: true,
        rateLimit: { max: PUBLIC_STATUS_RATE_MAX, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({
          number: banAppeals.number,
          status: banAppeals.status,
          createdAt: banAppeals.createdAt,
          decidedAt: banAppeals.decidedAt,
          decisionNote: banAppeals.decisionNote,
        })
        .from(banAppeals)
        .where(eq(banAppeals.trackingToken, req.params.token))
        .limit(1);
      if (!row) {
        reply.code(404);
        return { error: 'appeal_not_found' };
      }

      // Exactly five fields: the applicant never sees the internal note, the
      // contact they supplied, the resolved player, the appealed ban, their
      // own recorded IP, or who handled the appeal.
      return {
        number: Number(row.number),
        status: row.status,
        created_at: row.createdAt.toISOString(),
        decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
        decision_note: row.decisionNote,
      };
    },
  );
};

export default publicAppealsRoutes;
