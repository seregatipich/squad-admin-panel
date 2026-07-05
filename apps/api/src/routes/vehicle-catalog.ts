import { type VehicleCatalogRow, vehicleCatalog } from '@squad/db/schema';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const assetIdParam = z.object({
  assetId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.-]+$/),
});

const putBody = z.object({
  name_en: z.string().trim().min(1).max(128),
  name_ru: z.string().trim().min(1).max(128),
  vehicle_class: z.string().trim().min(1).max(64),
  icon: z.string().trim().min(1).max(256).nullish(),
});

interface VehicleCatalogView {
  asset_id: string;
  name_en: string;
  name_ru: string;
  vehicle_class: string;
  icon: string | null;
}

function serialize(row: VehicleCatalogRow): VehicleCatalogView {
  return {
    asset_id: row.assetId,
    name_en: row.nameEn,
    name_ru: row.nameRu,
    vehicle_class: row.vehicleClass,
    icon: row.icon,
  };
}

function readGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.combatView) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

function writeGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.permissions.has('config:edit')) {
    reply.code(403);
    return { error: 'forbidden', required: 'config:edit' };
  }
  return null;
}

const vehicleCatalogRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadRow(assetId: string): Promise<VehicleCatalogRow | null> {
    const rows = await app.db
      .select()
      .from(vehicleCatalog)
      .where(eq(vehicleCatalog.assetId, assetId))
      .limit(1);
    return rows[0] ?? null;
  }

  fast.get('/api/v1/vehicle-catalog', { config: { audit: false } }, async (req, reply) => {
    const denied = readGuard(req, reply);
    if (denied) return denied;
    const rows = await app.db.select().from(vehicleCatalog).orderBy(asc(vehicleCatalog.assetId));
    return { rows: rows.map(serialize) };
  });

  fast.put(
    '/api/v1/vehicle-catalog/:assetId',
    { schema: { params: assetIdParam, body: putBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = writeGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const { assetId } = req.params;
      const body = req.body;
      const before = await loadRow(assetId);

      const values = {
        assetId,
        nameEn: body.name_en,
        nameRu: body.name_ru,
        vehicleClass: body.vehicle_class,
        icon: body.icon ?? null,
      };

      await app.db
        .insert(vehicleCatalog)
        .values(values)
        .onConflictDoUpdate({
          target: vehicleCatalog.assetId,
          set: {
            nameEn: values.nameEn,
            nameRu: values.nameRu,
            vehicleClass: values.vehicleClass,
            icon: values.icon,
          },
        });

      const after = await loadRow(assetId);
      if (!after) {
        reply.code(500);
        return { error: 'persist_failed' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'vehicle_catalog.upsert',
        targetType: 'vehicle_catalog',
        targetId: assetId,
        before: before ? serialize(before) : null,
        after: serialize(after),
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });

      return serialize(after);
    },
  );
};

export default vehicleCatalogRoutes;
