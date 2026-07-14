import type { DatabaseClient } from '@squad/db';
import {
  type AltDetectionSettingsRow,
  altDetectionSettings,
  altIgnoredIps,
  players,
} from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { isValidIpOrCidr } from '../lib/ip-cidr.js';

const SINGLETON_ID = 1;
const WEIGHT_MAX = 1000;
const THRESHOLD_MAX = 1000;
const STEAMID_DELTA_MAX = 1_000_000_000;

const idParam = z.object({ id: z.string().uuid() });

const putBody = z
  .object({
    weight_shared_ip: z.number().int().min(0).max(WEIGHT_MAX).optional(),
    weight_shared_name: z.number().int().min(0).max(WEIGHT_MAX).optional(),
    weight_young_account: z.number().int().min(0).max(WEIGHT_MAX).optional(),
    weight_steamid_proximity: z.number().int().min(0).max(WEIGHT_MAX).optional(),
    steamid_delta_threshold: z.number().int().min(0).max(STEAMID_DELTA_MAX).optional(),
    medium_threshold: z.number().int().min(0).max(THRESHOLD_MAX).optional(),
    high_threshold: z.number().int().min(0).max(THRESHOLD_MAX).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

const createIgnoredIpBody = z.object({
  cidr: z.string().refine(isValidIpOrCidr, { message: 'invalid_cidr' }),
  note: z.string().trim().max(500).optional(),
});

interface SettingsView {
  weight_shared_ip: number;
  weight_shared_name: number;
  weight_young_account: number;
  weight_steamid_proximity: number;
  steamid_delta_threshold: number;
  medium_threshold: number;
  high_threshold: number;
  updated_at: string | null;
  updated_by_player_id: string | null;
}

interface IgnoredIpView {
  id: string;
  cidr: string;
  note: string | null;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
}

function serializeSettings(row: AltDetectionSettingsRow | null): SettingsView {
  if (!row) {
    return {
      weight_shared_ip: 50,
      weight_shared_name: 25,
      weight_young_account: 15,
      weight_steamid_proximity: 10,
      steamid_delta_threshold: 10_000,
      medium_threshold: 50,
      high_threshold: 75,
      updated_at: null,
      updated_by_player_id: null,
    };
  }
  return {
    weight_shared_ip: row.weightSharedIp,
    weight_shared_name: row.weightSharedName,
    weight_young_account: row.weightYoungAccount,
    weight_steamid_proximity: row.weightSteamidProximity,
    steamid_delta_threshold: Number(row.steamidDeltaThreshold),
    medium_threshold: row.mediumThreshold,
    high_threshold: row.highThreshold,
    updated_at: row.updatedAt.toISOString(),
    updated_by_player_id: row.updatedByPlayerId,
  };
}

async function auditMutation(
  db: DatabaseClient,
  req: FastifyRequest,
  input: { action: string; targetType: string; targetId: string; before: unknown; after: unknown },
): Promise<void> {
  if (!req.user) return;
  await writeAuditEntry(db, {
    actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
    actorIp: req.ip ?? null,
    actionType: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    before: input.before,
    after: input.after,
    context: { requestId: req.id, method: req.method, url: req.url },
  });
}

/**
 * ALT-1 settings routes: CRUD for the `alt_ignored_ips` VPN/CGNAT exclusion
 * list and the `alt_detection_settings` scoring-weight singleton consumed by
 * `GET /api/v1/players/:playerId/alt-candidates`. Gated on the same fine
 * `player:view_ips` permission as the candidates endpoint — a role that
 * cannot see IPs cannot tune or inspect how the IP-based detector scores.
 */
const settingsAltDetectionRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadSettings(): Promise<AltDetectionSettingsRow | null> {
    const rows = await app.db
      .select()
      .from(altDetectionSettings)
      .where(eq(altDetectionSettings.id, SINGLETON_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  async function loadIgnoredIps(): Promise<IgnoredIpView[]> {
    const rows = await app.db
      .select({
        id: altIgnoredIps.id,
        cidr: altIgnoredIps.cidr,
        note: altIgnoredIps.note,
        created_by: altIgnoredIps.createdBy,
        author_name: players.canonicalName,
        created_at: altIgnoredIps.createdAt,
      })
      .from(altIgnoredIps)
      .leftJoin(players, eq(players.id, altIgnoredIps.createdBy))
      .orderBy(desc(altIgnoredIps.createdAt));
    return rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
  }

  fast.get(
    '/api/v1/settings/alt-detection',
    { config: { permissions: ['player:view_ips'], audit: false } },
    async () => ({
      settings: serializeSettings(await loadSettings()),
      ignored_ips: await loadIgnoredIps(),
    }),
  );

  fast.put(
    '/api/v1/settings/alt-detection',
    { schema: { body: putBody }, config: { permissions: ['player:view_ips'], audit: false } },
    async (req, reply) => {
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by the player:view_ips permission gate
      const actorId = req.user!.playerId;
      const before = serializeSettings(await loadSettings());
      const body = req.body;

      const nextMedium = body.medium_threshold ?? before.medium_threshold;
      const nextHigh = body.high_threshold ?? before.high_threshold;
      if (nextMedium > nextHigh) {
        reply.code(400);
        return { error: 'medium_threshold_above_high_threshold' };
      }

      const updates: Partial<typeof altDetectionSettings.$inferInsert> = {
        updatedByPlayerId: actorId,
        updatedAt: new Date(),
      };
      if (body.weight_shared_ip !== undefined) updates.weightSharedIp = body.weight_shared_ip;
      if (body.weight_shared_name !== undefined) updates.weightSharedName = body.weight_shared_name;
      if (body.weight_young_account !== undefined)
        updates.weightYoungAccount = body.weight_young_account;
      if (body.weight_steamid_proximity !== undefined)
        updates.weightSteamidProximity = body.weight_steamid_proximity;
      if (body.steamid_delta_threshold !== undefined)
        updates.steamidDeltaThreshold = body.steamid_delta_threshold;
      if (body.medium_threshold !== undefined) updates.mediumThreshold = body.medium_threshold;
      if (body.high_threshold !== undefined) updates.highThreshold = body.high_threshold;

      await app.db
        .insert(altDetectionSettings)
        .values({ id: SINGLETON_ID, ...updates })
        .onConflictDoUpdate({ target: altDetectionSettings.id, set: updates });

      const after = serializeSettings(await loadSettings());
      await auditMutation(app.db, req, {
        action: 'alt_detection.settings.update',
        targetType: 'alt_detection_settings',
        targetId: String(SINGLETON_ID),
        before,
        after,
      });
      return after;
    },
  );

  fast.post(
    '/api/v1/settings/alt-detection/ignored-ips',
    {
      schema: { body: createIgnoredIpBody },
      config: { permissions: ['player:view_ips'], audit: false },
    },
    async (req, reply) => {
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by the player:view_ips permission gate
      const actorId = req.user!.playerId;
      let inserted: typeof altIgnoredIps.$inferSelect | undefined;
      try {
        const result = await app.db
          .insert(altIgnoredIps)
          .values({ cidr: req.body.cidr, note: req.body.note ?? null, createdBy: actorId })
          .returning();
        inserted = result[0];
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505'
        ) {
          reply.code(409);
          return { error: 'cidr_already_ignored' };
        }
        throw err;
      }
      if (!inserted) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      reply.code(201);
      await auditMutation(app.db, req, {
        action: 'alt_detection.ignored_ip.create',
        targetType: 'alt_ignored_ip',
        targetId: inserted.id,
        before: null,
        after: { id: inserted.id, cidr: inserted.cidr, note: inserted.note },
      });
      return {
        id: inserted.id,
        cidr: inserted.cidr,
        note: inserted.note,
        created_by: inserted.createdBy,
        author_name: req.user?.canonicalName ?? null,
        created_at: inserted.createdAt.toISOString(),
      };
    },
  );

  fast.delete(
    '/api/v1/settings/alt-detection/ignored-ips/:id',
    { schema: { params: idParam }, config: { permissions: ['player:view_ips'], audit: false } },
    async (req, reply) => {
      const existingRows = await app.db
        .select()
        .from(altIgnoredIps)
        .where(eq(altIgnoredIps.id, req.params.id))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        reply.code(404);
        return { error: 'not_found' };
      }
      await app.db.delete(altIgnoredIps).where(eq(altIgnoredIps.id, req.params.id));
      await auditMutation(app.db, req, {
        action: 'alt_detection.ignored_ip.delete',
        targetType: 'alt_ignored_ip',
        targetId: existing.id,
        before: { id: existing.id, cidr: existing.cidr, note: existing.note },
        after: null,
      });
      return { ok: true };
    },
  );
};

export default settingsAltDetectionRoutes;
