import { layers, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import {
  buildRotationSegmentBody,
  findManagedSegment,
  parseRotationSegment,
  spliceManagedSegment,
  validateLayerName,
} from '../lib/rotation-segment.js';
import { writeVersion } from './server-configs.js';

const idParams = z.object({ id: z.string().uuid() });
const putBody = z.object({
  layers: z.array(z.string().min(1).max(128)).max(200),
});

function rotationPath(serverId: string): string {
  return `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/LayerRotation.cfg`;
}

interface CatalogInfo {
  map: string;
  gamemode: string;
  version: string;
  is_seed: boolean;
  deprecated: boolean;
}

/**
 * ROT-2 (#145): rotation editor for `LayerRotation.cfg`. Reads/writes only
 * the `//SQUAD-PANEL BEGIN`/`//SQUAD-PANEL END` managed segment (see
 * `../lib/rotation-segment.ts`) — content outside the segment (operator
 * comments, manually added lines) is preserved byte-for-byte. Reuses the
 * CFG-1 `config_versions` history via `writeVersion` and the ROT-1 layer
 * catalog (`layers` table) to flag entries unknown to the catalog.
 *
 * Read gate: `panel_access`. Write gate: squad permission `changemap` (an
 * Owner short-circuits both, per `loadUserPermissions`).
 */
const serverRotationRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers/:id/rotation',
    { config: { audit: false }, schema: { params: idParams } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const canEdit = req.user.permissions.squadPermissions.has('changemap');

      let content: string | null = null;
      try {
        const res = await app.bridge.fileRead({ path: rotationPath(req.params.id) });
        content = res.content;
      } catch {
        content = null;
      }

      if (content === null) {
        return {
          file_exists: false,
          has_managed_segment: false,
          entries: [],
          behavior: 'rotation',
          can_edit: canEdit,
        };
      }

      const parsed = parseRotationSegment(content);
      const hasManagedSegment = findManagedSegment(content) !== null;

      const catalogRows =
        parsed.layers.length > 0
          ? await app.db
              .select({
                name: layers.name,
                map: layers.map,
                gamemode: layers.gamemode,
                version: layers.version,
                isSeed: layers.isSeed,
                deprecated: layers.deprecated,
              })
              .from(layers)
              .where(inArray(layers.name, parsed.layers))
          : [];
      const catalog = new Map<string, CatalogInfo>(
        catalogRows.map((row) => [
          row.name,
          {
            map: row.map,
            gamemode: row.gamemode,
            version: row.version,
            is_seed: row.isSeed,
            deprecated: row.deprecated,
          },
        ]),
      );

      const entries = parsed.layers.map((name) => {
        const info = catalog.get(name);
        return {
          layer: name,
          known: info !== undefined,
          map: info?.map ?? null,
          gamemode: info?.gamemode ?? null,
          version: info?.version ?? null,
          is_seed: info?.is_seed ?? null,
          deprecated: info?.deprecated ?? null,
        };
      });

      return {
        file_exists: true,
        has_managed_segment: hasManagedSegment,
        entries,
        behavior: 'rotation',
        can_edit: canEdit,
      };
    },
  );

  fast.put(
    '/api/v1/servers/:id/rotation',
    { config: { audit: false }, schema: { params: idParams, body: putBody } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.squadPermissions.has('changemap')) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permission: 'changemap' };
      }

      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      for (const name of req.body.layers) {
        if (!validateLayerName(name)) {
          reply.code(400);
          return { error: 'invalid_layer_name', layer: name };
        }
      }

      let current: string;
      try {
        const res = await app.bridge.fileRead({ path: rotationPath(req.params.id) });
        current = res.content;
      } catch {
        current = '';
      }

      const beforeSegment = findManagedSegment(current)?.segment ?? null;
      const newBody = buildRotationSegmentBody(req.body.layers);
      const newContent = spliceManagedSegment(current, newBody);

      const result = await writeVersion(
        app,
        req.params.id,
        'LayerRotation.cfg',
        newContent,
        'rotation editor',
        req.user.playerId,
        req.ip ?? null,
      );

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.rotation.write',
        targetType: 'server',
        targetId: req.params.id,
        context: {
          before_segment: beforeSegment,
          after_segment: newBody,
          layer_count: req.body.layers.length,
        },
        statusCode: reply.statusCode,
      });

      return { ...result, behavior: 'rotation' };
    },
  );
};

export default serverRotationRoutes;
