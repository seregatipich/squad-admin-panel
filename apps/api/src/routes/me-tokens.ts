import { playerApiTokens } from '@squad/db/schema';
import { PERMISSION_KEYS } from '@squad/shared-config';
import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mintApiToken, validateScopesSubset } from '../lib/api-tokens.js';

const NAME_MIN = 1;
const NAME_MAX = 100;
const MAX_ACTIVE_TOKENS_PER_USER = 25;
/**
 * Revoked tokens are kept for the audit FK, so a create/revoke loop grows the
 * table without bound; the list returns every active token but only the most
 * recently revoked ones.
 */
export const REVOKED_TOKENS_LISTED = 50;

/** The token list's columns, shared by its active and revoked halves. */
const tokenListColumns = {
  id: playerApiTokens.id,
  name: playerApiTokens.name,
  scopes: playerApiTokens.scopes,
  lastUsedAt: playerApiTokens.lastUsedAt,
  createdAt: playerApiTokens.createdAt,
  revokedAt: playerApiTokens.revokedAt,
};

const meTokensRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/me/tokens', { config: { audit: false } }, async (req, reply) => {
    if (!req.user || !req.session) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    const [activeRows, revokedRows] = await Promise.all([
      app.db
        .select(tokenListColumns)
        .from(playerApiTokens)
        .where(
          and(eq(playerApiTokens.playerId, req.user.playerId), isNull(playerApiTokens.revokedAt)),
        ),
      app.db
        .select(tokenListColumns)
        .from(playerApiTokens)
        .where(
          and(
            eq(playerApiTokens.playerId, req.user.playerId),
            isNotNull(playerApiTokens.revokedAt),
          ),
        )
        .orderBy(desc(playerApiTokens.revokedAt))
        .limit(REVOKED_TOKENS_LISTED),
    ]);
    const rows = [...activeRows, ...revokedRows].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      scopes: r.scopes,
      last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      created_at: r.createdAt.toISOString(),
      revoked_at: r.revokedAt ? r.revokedAt.toISOString() : null,
    }));
  });

  fast.post(
    '/api/v1/me/tokens',
    {
      schema: {
        body: z.object({
          name: z.string().trim().min(NAME_MIN).max(NAME_MAX),
          scopes: z.array(z.string()).max(PERMISSION_KEYS.length),
        }),
      },
      config: { audit: { action: 'user.api_token.create', resource: 'api_token' } },
    },
    async (req, reply) => {
      if (!req.user || !req.session) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const dedupedScopes = Array.from(new Set(req.body.scopes));
      const validation = validateScopesSubset(dedupedScopes, req.user.permissions.permissions);
      if (!validation.ok) {
        reply.code(422);
        return {
          error: 'invalid_scopes',
          unknown: validation.unknown,
          not_granted: validation.notGranted,
        };
      }
      const minted = mintApiToken();
      const playerId = req.user.playerId;
      // Count and insert under a per-player advisory lock, so parallel
      // creates cannot each see 24 active tokens and all insert.
      const inserted = await app.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('player_api_tokens'), hashtext(${playerId}))`,
        );
        const [active] = await tx
          .select({ total: count() })
          .from(playerApiTokens)
          .where(and(eq(playerApiTokens.playerId, playerId), isNull(playerApiTokens.revokedAt)));
        if ((active?.total ?? 0) >= MAX_ACTIVE_TOKENS_PER_USER) return null;
        return tx
          .insert(playerApiTokens)
          .values({
            id: minted.id,
            playerId,
            name: req.body.name,
            tokenHash: minted.tokenHash,
            scopes: dedupedScopes,
          })
          .returning({
            id: playerApiTokens.id,
            name: playerApiTokens.name,
            scopes: playerApiTokens.scopes,
            createdAt: playerApiTokens.createdAt,
          });
      });
      if (inserted === null) {
        reply.code(409);
        return { error: 'too_many_active_tokens', limit: MAX_ACTIVE_TOKENS_PER_USER };
      }
      const row = inserted[0];
      if (!row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      reply.code(201);
      return {
        id: row.id,
        name: row.name,
        scopes: row.scopes,
        created_at: row.createdAt.toISOString(),
        plaintext: minted.plaintext,
      };
    },
  );

  fast.delete(
    '/api/v1/me/tokens/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
      config: { audit: { action: 'user.api_token.revoke', resource: 'api_token' } },
    },
    async (req, reply) => {
      if (!req.user || !req.session) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const target = await app.db
        .select({ id: playerApiTokens.id, revokedAt: playerApiTokens.revokedAt })
        .from(playerApiTokens)
        .where(
          and(
            eq(playerApiTokens.id, req.params.id),
            eq(playerApiTokens.playerId, req.user.playerId),
          ),
        )
        .limit(1);
      const row = target[0];
      if (!row) {
        reply.code(404);
        return { error: 'token_not_found' };
      }
      if (row.revokedAt) {
        return { ok: true, already_revoked: true };
      }
      await app.db
        .update(playerApiTokens)
        .set({ revokedAt: new Date() })
        .where(eq(playerApiTokens.id, req.params.id));
      return { ok: true };
    },
  );
};

export default meTokensRoutes;
