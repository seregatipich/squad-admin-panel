import { type SeasonRow, seasons } from '@squad/db/schema';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

const NAME_MAX = 120;

const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z.enum(['upcoming', 'active', 'closed']).optional(),
});

// `closed` is deliberately absent: a season is closed by the finalize tick or by
// an explicit PATCH, never born that way.
const createBody = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  status: z.enum(['upcoming', 'active']).default('upcoming'),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    starts_at: z.string().datetime().optional(),
    ends_at: z.string().datetime().optional(),
    status: z.enum(['upcoming', 'active', 'closed']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

interface SeasonView {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  finalized: boolean;
}

function serialize(row: SeasonRow): SeasonView {
  return {
    id: row.id,
    name: row.name,
    starts_at: row.startsAt.toISOString(),
    ends_at: row.endsAt.toISOString(),
    status: row.status,
    finalized: row.finalized,
  };
}

/**
 * Season management is gated on the `can_edit_roles` capability flag rather
 * than a permission-catalogue key, matching the VIP tier catalogue
 * (`vip-tiers.ts`). Owner short-circuits every capability in `lib/rbac.ts`.
 *
 * The flag is not exposed by `GET /api/v1/me`, so the UI gates itself by
 * hiding the management surface on a 403 rather than by reading a boolean.
 */
function editRolesGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.canEditRoles) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_edit_roles' };
  }
  return null;
}

function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

/**
 * Resolves the constraint a unique violation broke.
 *
 * drizzle-orm 0.45.2 wraps driver errors: the wrapper carries only a
 * "Failed query: ..." message, while SQLSTATE and `constraint_name` sit on
 * `err.cause`. Both season conflicts are 23505, so the constraint name is the
 * only way to tell "second active season" from "duplicate name" — matching on
 * the message would silently mislabel one as the other.
 */
function uniqueViolationConstraint(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const candidate = current as { code?: string; constraint_name?: string; cause?: unknown };
    if (candidate.code === '23505') return candidate.constraint_name ?? '';
    current = candidate.cause;
  }
  return null;
}

function conflictFor(constraint: string): { code: number; error: string } {
  if (constraint === 'seasons_one_active') return { code: 409, error: 'active_season_exists' };
  if (constraint === 'seasons_name_key') return { code: 409, error: 'season_name_taken' };
  return { code: 409, error: 'season_conflict' };
}

const seasonsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadRow(id: string): Promise<SeasonRow | null> {
    const rows = await app.db.select().from(seasons).where(eq(seasons.id, id)).limit(1);
    return rows[0] ?? null;
  }

  fast.get(
    '/api/v1/seasons',
    {
      schema: {
        tags: ['seasons'],
        summary: 'List leaderboard seasons',
        querystring: listQuery,
      },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const rows = req.query.status
        ? await app.db
            .select()
            .from(seasons)
            .where(eq(seasons.status, req.query.status))
            .orderBy(asc(seasons.startsAt))
        : await app.db.select().from(seasons).orderBy(asc(seasons.startsAt));

      return { items: rows.map(serialize) };
    },
  );

  fast.post(
    '/api/v1/seasons',
    {
      schema: {
        tags: ['seasons'],
        summary: 'Create a leaderboard season',
        body: createBody,
      },
      config: { audit: { action: 'season.create', resource: 'season' } },
    },
    async (req, reply) => {
      const denied = editRolesGuard(req, reply);
      if (denied) return denied;

      const body = req.body;
      const startsAt = new Date(body.starts_at);
      const endsAt = new Date(body.ends_at);
      if (endsAt.getTime() <= startsAt.getTime()) {
        reply.code(400);
        return { error: 'invalid_bounds' };
      }

      const id = uuidv7();
      try {
        await app.db.insert(seasons).values({
          id,
          name: body.name,
          startsAt,
          endsAt,
          status: body.status,
        });
      } catch (err) {
        const constraint = uniqueViolationConstraint(err);
        if (constraint === null) throw err;
        const conflict = conflictFor(constraint);
        reply.code(conflict.code);
        return { error: conflict.error };
      }

      const after = await loadRow(id);
      if (!after) {
        reply.code(500);
        return { error: 'persist_failed' };
      }

      req.auditSnapshots = { before: null, after: serialize(after), targetId: id };
      reply.code(201);
      return serialize(after);
    },
  );

  fast.patch(
    '/api/v1/seasons/:id',
    {
      schema: {
        tags: ['seasons'],
        summary: 'Update a leaderboard season',
        params: idParam,
        body: updateBody,
      },
      config: { audit: { action: 'season.update', resource: 'season' } },
    },
    async (req, reply) => {
      const denied = editRolesGuard(req, reply);
      if (denied) return denied;

      const before = await loadRow(req.params.id);
      if (!before) {
        reply.code(404);
        return { error: 'season_not_found' };
      }
      // A finalized season's materialised rows are frozen, so its window and
      // lifecycle must stop moving too — otherwise the stored slice would no
      // longer describe the season it belongs to.
      if (before.finalized) {
        reply.code(422);
        return { error: 'season_finalized' };
      }

      const body = req.body;
      const nextStartsAt = body.starts_at ? new Date(body.starts_at) : before.startsAt;
      const nextEndsAt = body.ends_at ? new Date(body.ends_at) : before.endsAt;
      if (nextEndsAt.getTime() <= nextStartsAt.getTime()) {
        reply.code(400);
        return { error: 'invalid_bounds' };
      }

      const updates: Partial<typeof seasons.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.starts_at !== undefined) updates.startsAt = nextStartsAt;
      if (body.ends_at !== undefined) updates.endsAt = nextEndsAt;
      if (body.status !== undefined) updates.status = body.status;

      try {
        await app.db.update(seasons).set(updates).where(eq(seasons.id, req.params.id));
      } catch (err) {
        const constraint = uniqueViolationConstraint(err);
        if (constraint === null) throw err;
        const conflict = conflictFor(constraint);
        reply.code(conflict.code);
        return { error: conflict.error };
      }

      const after = await loadRow(req.params.id);
      if (!after) {
        reply.code(500);
        return { error: 'persist_failed' };
      }

      req.auditSnapshots = { before: serialize(before), after: serialize(after) };
      return serialize(after);
    },
  );
};

export default seasonsRoutes;
