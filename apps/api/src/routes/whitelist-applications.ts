import { panelMeta, players, roles, whitelistApplications } from '@squad/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';
import { callerCanManageRoles, whitelistRoleWriteDenial } from '../lib/whitelist-role-guard.js';

const PANEL_META_SINGLETON_ID = 1;
const STEAM_ID64_RE = /^\d{17}$/;
const BODY_MAX = 2000;
const CONTACT_MAX = 128;
const REVIEW_NOTE_MAX = 2000;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const PUBLIC_SUBMIT_RATE_MAX = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Postgres unique_violation — the partial `pending` unique index tripped. */
const PG_UNIQUE_VIOLATION = '23505';

const statusEnum = z.enum(['pending', 'approved', 'rejected']);

const submitBody = z.object({
  /**
   * Optional and never trusted: the applicant is the Steam-verified session's
   * SteamID64 (#375). When sent, it must match that SteamID64.
   */
  steam_id64: z.string().regex(STEAM_ID64_RE).optional(),
  body: z.string().trim().min(1).max(BODY_MAX),
  contact: z.string().trim().max(CONTACT_MAX).optional(),
});

const listQuery = z.object({
  status: statusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

const settingsBody = z.object({
  enabled: z.boolean(),
  default_days: z.number().int().min(1).max(3650).nullable(),
});

const idParam = z.object({ id: z.string().uuid() });

const patchBody = z.object({
  status: z.enum(['approved', 'rejected']),
  review_note: z.string().trim().max(REVIEW_NOTE_MAX).nullable().optional(),
  role_id: z.string().uuid().nullable().optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

interface ApplicationSettings {
  enabled: boolean;
  default_days: number | null;
}

interface ApplicationRow {
  id: string;
  steamId64: bigint;
  playerId: string | null;
  playerName: string | null;
  contact: string | null;
  body: string;
  requestedRoleId: string | null;
  requestedRoleName: string | null;
  status: string;
  reviewerPlayerId: string | null;
  reviewerName: string | null;
  reviewNote: string | null;
  grantedRoleId: string | null;
  grantedRoleName: string | null;
  grantedUntil: Date | null;
  source: string;
  verified: boolean;
  createdAt: Date;
  decidedAt: Date | null;
}

function serializeApplication(row: ApplicationRow) {
  return {
    id: row.id,
    steam_id64: row.steamId64.toString(),
    player_id: row.playerId,
    player_name: row.playerName,
    contact: row.contact,
    body: row.body,
    requested_role_id: row.requestedRoleId,
    requested_role_name: row.requestedRoleName,
    status: row.status,
    reviewer_player_id: row.reviewerPlayerId,
    reviewer_name: row.reviewerName,
    review_note: row.reviewNote,
    granted_role_id: row.grantedRoleId,
    granted_role_name: row.grantedRoleName,
    granted_until: row.grantedUntil ? row.grantedUntil.toISOString() : null,
    source: row.source,
    verified: row.verified,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

function actorFrom(req: FastifyRequest): AuditActor {
  return req.user
    ? { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null }
    : { kind: 'system', label: 'http-anonymous' };
}

/**
 * Public whitelist/VIP application portal + panel approval workflow (WL-3, #67).
 *
 * The public half (`/api/v1/public/whitelist/*`) is rate limited: anyone can
 * read whether the portal is open, and a player signed in through Steam
 * OpenID (a `self_service` session is enough) submits one pending application
 * for their own SteamID64 — never for a SteamID64 they merely typed in (#375). The panel half (`/api/v1/whitelist/applications*`)
 * is gated on `whitelist:view`/`whitelist:edit` and drives the review queue.
 *
 * Approving a pending application grants the resolved role to the matching
 * `players` row — time-bounded via `players.role_expires_at` (mirrored in
 * `granted_until`) so the existing `worker-role-expirer` clears it automatically
 * when the term lapses (VIPSUB-1 reuse; WL-3 adds no new expiry mechanic). The
 * grant fans out to every active server's Admins.cfg via the durable outbox,
 * exactly like a manual role assignment. Approval never grants the Owner role
 * or demotes an Owner, and a reviewer without `user:manage_roles` may only
 * grant the configured whitelist role to an applicant holding no other role
 * (#8, see `whitelistRoleWriteDenial`).
 */
const whitelistApplicationsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const requestedRole = alias(roles, 'requested_role');
  const grantedRole = alias(roles, 'granted_role');
  const reviewer = alias(players, 'reviewer');

  async function loadSettings(): Promise<ApplicationSettings> {
    const rows = await app.db
      .select({
        enabled: panelMeta.whitelistApplicationsEnabled,
        defaultDays: panelMeta.whitelistApplicationDefaultDays,
      })
      .from(panelMeta)
      .where(eq(panelMeta.id, PANEL_META_SINGLETON_ID))
      .limit(1);
    const row = rows[0];
    return {
      enabled: row?.enabled ?? false,
      default_days: row?.defaultDays ?? null,
    };
  }

  function baseSelection() {
    return app.db
      .select({
        id: whitelistApplications.id,
        steamId64: whitelistApplications.steamId64,
        playerId: whitelistApplications.playerId,
        playerName: players.canonicalName,
        contact: whitelistApplications.contact,
        body: whitelistApplications.body,
        requestedRoleId: whitelistApplications.requestedRoleId,
        requestedRoleName: requestedRole.name,
        status: whitelistApplications.status,
        reviewerPlayerId: whitelistApplications.reviewerPlayerId,
        reviewerName: reviewer.canonicalName,
        reviewNote: whitelistApplications.reviewNote,
        grantedRoleId: whitelistApplications.grantedRoleId,
        grantedRoleName: grantedRole.name,
        grantedUntil: whitelistApplications.grantedUntil,
        source: whitelistApplications.source,
        verified: whitelistApplications.verified,
        createdAt: whitelistApplications.createdAt,
        decidedAt: whitelistApplications.decidedAt,
      })
      .from(whitelistApplications)
      .leftJoin(players, eq(players.id, whitelistApplications.playerId))
      .leftJoin(requestedRole, eq(requestedRole.id, whitelistApplications.requestedRoleId))
      .leftJoin(grantedRole, eq(grantedRole.id, whitelistApplications.grantedRoleId))
      .leftJoin(reviewer, eq(reviewer.id, whitelistApplications.reviewerPlayerId));
  }

  async function loadApplication(id: string): Promise<ApplicationRow | null> {
    const rows: ApplicationRow[] = await baseSelection()
      .where(eq(whitelistApplications.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // --- Public: portal status ------------------------------------------------
  fast.get(
    '/api/v1/public/whitelist/settings',
    { config: { audit: false, public: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => {
      const settings = await loadSettings();
      return { enabled: settings.enabled };
    },
  );

  // --- Public: submit an application ----------------------------------------
  fast.post(
    '/api/v1/public/whitelist/applications',
    {
      schema: { body: submitBody },
      config: {
        audit: 'manual',
        // `public` so an anonymous caller gets the explicit 401 below;
        // `selfService` so a Steam login without panel access is honoured.
        public: true,
        selfService: true,
        rateLimit: { max: PUBLIC_SUBMIT_RATE_MAX, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const settings = await loadSettings();
      if (!settings.enabled) {
        reply.code(404);
        return { error: 'applications_disabled' };
      }

      // Ownership of the SteamID64 is proven by the Steam OpenID login behind
      // the session; a typed-in SteamID64 let anyone file (and block) an
      // application in someone else's name (#375).
      if (!req.user) {
        reply.code(401);
        return { error: 'steam_login_required' };
      }
      const steamId64 = req.user.steamId64;
      if (steamId64 === null) {
        reply.code(403);
        return { error: 'steam_account_required' };
      }
      if (req.body.steam_id64 !== undefined && BigInt(req.body.steam_id64) !== steamId64) {
        reply.code(403);
        return { error: 'steam_id_mismatch' };
      }
      const contact = req.body.contact?.trim() || null;

      let created: ApplicationRow;
      try {
        const [inserted] = await app.db
          .insert(whitelistApplications)
          .values({
            steamId64,
            playerId: req.user.playerId,
            contact,
            body: req.body.body,
            source: 'public',
            status: 'pending',
            verified: true,
          })
          .returning({ id: whitelistApplications.id });
        if (!inserted) throw new Error('whitelist_applications insert returned no row');
        const loaded = await loadApplication(inserted.id);
        if (!loaded) throw new Error('whitelist_applications insert returned no row');
        created = loaded;
      } catch (err) {
        // drizzle wraps the driver error; the PG code may sit on the error or
        // its `.cause` depending on the failure path.
        const code =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code === PG_UNIQUE_VIOLATION) {
          reply.code(409);
          return { error: 'application_already_pending' };
        }
        throw err;
      }

      await writeAuditEntry(app.db, {
        actor: actorFrom(req),
        actorIp: req.ip ?? null,
        actionType: 'whitelist.application.create',
        targetType: 'whitelist_application',
        targetId: created.id,
        after: serializeApplication(created),
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 201,
      });

      reply.code(201);
      return serializeApplication(created);
    },
  );

  // --- Panel: application settings ------------------------------------------
  fast.get(
    '/api/v1/whitelist/applications/settings',
    { config: { permissions: ['whitelist:view'], audit: false } },
    async () => loadSettings(),
  );

  fast.put(
    '/api/v1/whitelist/applications/settings',
    {
      schema: { body: settingsBody },
      config: { permissions: ['whitelist:edit'], audit: 'manual' },
    },
    async (req) => {
      const before = await loadSettings();
      await app.db
        .update(panelMeta)
        .set({
          whitelistApplicationsEnabled: req.body.enabled,
          whitelistApplicationDefaultDays: req.body.default_days,
        })
        .where(eq(panelMeta.id, PANEL_META_SINGLETON_ID));
      const after = await loadSettings();
      await writeAuditEntry(app.db, {
        actor: actorFrom(req),
        actorIp: req.ip ?? null,
        actionType: 'whitelist.application.settings.update',
        targetType: 'panel_meta',
        targetId: String(PANEL_META_SINGLETON_ID),
        before,
        after,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });
      return after;
    },
  );

  // --- Panel: review queue --------------------------------------------------
  fast.get(
    '/api/v1/whitelist/applications',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['whitelist:view'], audit: false },
    },
    async (req) => {
      const { page, page_size: pageSize } = req.query;
      const where = req.query.status
        ? eq(whitelistApplications.status, req.query.status)
        : undefined;

      const countRows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(whitelistApplications)
        .where(where);
      const total = countRows[0]?.total ?? 0;

      const rows: ApplicationRow[] = await baseSelection()
        .where(where)
        .orderBy(desc(whitelistApplications.createdAt), desc(whitelistApplications.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map(serializeApplication),
        total,
        page,
        page_size: pageSize,
      };
    },
  );

  // --- Panel: approve / reject ----------------------------------------------
  fast.patch(
    '/api/v1/whitelist/applications/:id',
    {
      schema: { params: idParam, body: patchBody },
      config: { permissions: ['whitelist:edit'], audit: 'manual' },
    },
    async (req, reply) => {
      // biome-ignore lint/style/noNonNullAssertion: whitelist:edit gate guarantees req.user
      const reviewerPlayerId = req.user!.playerId;

      const existing = await loadApplication(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'application_not_found' };
      }
      if (existing.status !== 'pending') {
        reply.code(409);
        return { error: 'application_not_pending' };
      }
      const before = serializeApplication(existing);

      if (req.body.status === 'rejected') {
        const now = new Date();
        const decided = await app.db
          .update(whitelistApplications)
          .set({
            status: 'rejected',
            reviewerPlayerId,
            reviewNote: req.body.review_note ?? null,
            decidedAt: now,
          })
          .where(stillPending(existing.id))
          .returning({ id: whitelistApplications.id });
        if (decided.length === 0) {
          reply.code(409);
          return { error: 'application_not_pending' };
        }
        const updated = await loadApplication(existing.id);
        if (!updated) {
          reply.code(404);
          return { error: 'not_found' };
        }
        const after = serializeApplication(updated);
        await writeAuditEntry(app.db, {
          actor: actorFrom(req),
          actorIp: req.ip ?? null,
          actionType: 'whitelist.application.review',
          targetType: 'whitelist_application',
          targetId: existing.id,
          before,
          after,
          context: { requestId: req.id, method: req.method, url: req.url, decision: 'rejected' },
          statusCode: 200,
        });
        return after;
      }

      // --- Approve --------------------------------------------------------
      const [applicant] = await app.db
        .select({
          id: players.id,
          currentRole: { id: roles.id, name: roles.name, isSystemRole: roles.isSystemRole },
        })
        .from(players)
        .leftJoin(roles, eq(roles.id, players.roleId))
        .where(eq(players.steamId64, existing.steamId64))
        .limit(1);
      if (!applicant) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      if (applicant.id === reviewerPlayerId) {
        reply.code(403);
        return { error: 'self_approval_forbidden' };
      }

      const settings = await loadSettings();
      const whitelistRoleId = await loadWhitelistRoleId();
      const resolvedRoleId = req.body.role_id ?? existing.requestedRoleId ?? whitelistRoleId;
      if (!resolvedRoleId) {
        reply.code(409);
        return { error: 'whitelist_role_not_configured' };
      }

      const [role] = await app.db
        .select({
          id: roles.id,
          name: roles.name,
          isSystemRole: roles.isSystemRole,
          panelAccess: roles.panelAccess,
        })
        .from(roles)
        .where(eq(roles.id, resolvedRoleId))
        .limit(1);
      if (!role) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      const denial = whitelistRoleWriteDenial({
        canManageRoles: callerCanManageRoles(req),
        targetRole: role,
        whitelistRoleId,
        currentRole: applicant.currentRole,
      });
      if (denial) {
        reply.code(denial.status);
        return { error: denial.error };
      }

      const now = new Date();
      let grantedUntil: Date | null;
      if (req.body.expires_at != null) {
        grantedUntil = new Date(req.body.expires_at);
        if (grantedUntil <= now) {
          reply.code(400);
          return { error: 'role_expiry_must_be_future' };
        }
      } else if (settings.default_days != null) {
        grantedUntil = new Date(now.getTime() + settings.default_days * DAY_MS);
      } else {
        grantedUntil = null;
      }

      const roleComment = req.body.review_note?.trim() || 'whitelist application';

      const approved = await app.db.transaction(async (tx) => {
        // Claim the application first: only the decision that flips it out of
        // `pending` goes on to grant the role, so a concurrent approve/reject
        // or a double click can never both land (#374).
        const decided = await tx
          .update(whitelistApplications)
          .set({
            status: 'approved',
            reviewerPlayerId,
            reviewNote: req.body.review_note ?? null,
            grantedRoleId: resolvedRoleId,
            grantedUntil,
            decidedAt: now,
          })
          .where(stillPending(existing.id))
          .returning({ id: whitelistApplications.id });
        if (decided.length === 0) return false;
        await tx
          .update(players)
          .set({ roleId: resolvedRoleId, roleExpiresAt: grantedUntil, roleComment })
          .where(eq(players.id, applicant.id));
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'whitelist.application.approve',
          actor_player_id: reviewerPlayerId,
          enqueued_at: now.toISOString(),
          request_id: req.id,
        });
        return true;
      });
      if (!approved) {
        reply.code(409);
        return { error: 'application_not_pending' };
      }

      invalidatePermissionCache(applicant.id);
      if (!role.panelAccess) {
        await revokeAllForPlayer(app.db, app.redis, applicant.id, app.liveBus);
      }

      const updated = await loadApplication(existing.id);
      if (!updated) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const after = serializeApplication(updated);
      await writeAuditEntry(app.db, {
        actor: actorFrom(req),
        actorIp: req.ip ?? null,
        actionType: 'whitelist.application.review',
        targetType: 'whitelist_application',
        targetId: existing.id,
        before,
        after,
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url,
          decision: 'approved',
          granted_role_id: resolvedRoleId,
          player_id: applicant.id,
        },
        statusCode: 200,
      });
      return after;
    },
  );

  /** Matches the application only while it is still undecided. */
  function stillPending(id: string) {
    return and(eq(whitelistApplications.id, id), eq(whitelistApplications.status, 'pending'));
  }

  async function loadWhitelistRoleId(): Promise<string | null> {
    const rows = await app.db
      .select({ whitelistRoleId: panelMeta.whitelistRoleId })
      .from(panelMeta)
      .where(eq(panelMeta.id, PANEL_META_SINGLETON_ID))
      .limit(1);
    return rows[0]?.whitelistRoleId ?? null;
  }
};

export default whitelistApplicationsRoutes;
