import { randomBytes } from 'node:crypto';
import { configVersions, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, desc, eq, isNotNull, isNull, like } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { encrypt, serialize } from '../lib/crypto.js';
import { restoreConfigsFromArchive } from '../lib/server-restore.js';

const idParam = z.object({ id: z.string().uuid() });
const idAndFilename = z.object({
  id: z.string().uuid(),
  filename: z.string().regex(/^[A-Za-z0-9_-]+\.cfg$/),
});

const portSchema = z.number().int().min(1024).max(65_535);
const restoreBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  display_name: z.string().min(1).max(120).optional(),
  game_port: portSchema.optional(),
  query_port: portSchema.optional(),
  beacon_port: portSchema.optional(),
  rcon_port: portSchema.optional(),
});

const restoreConfigsBody = z.object({
  from_archive_id: z.string().uuid(),
});

const archiveRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers/archive',
    { config: { permissions: ['server:view'], audit: false } },
    async () => {
      const rows = await app.db
        .select({
          id: servers.id,
          display_name: servers.displayName,
          slug: servers.slug,
          description: servers.description,
          status: servers.status,
          tags: servers.tags,
          created_at: servers.createdAt,
          deleted_at: servers.deletedAt,
          deleted_by_steam_id64: servers.deletedBySteamId64,
          deletion_backup_marker_id: servers.deletionBackupMarkerId,
        })
        .from(servers)
        .where(isNotNull(servers.deletedAt))
        .orderBy(desc(servers.deletedAt));
      return {
        items: rows.map((r) => ({
          ...r,
          deleted_by_steam_id64: r.deleted_by_steam_id64 ? String(r.deleted_by_steam_id64) : null,
        })),
        total: rows.length,
      };
    },
  );

  fast.get(
    '/api/v1/servers/archive/:id',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: idParam },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNotNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const settingsRow = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, row.id),
      });
      const backups = await app.db
        .select({
          id: configVersions.id,
          filename: configVersions.filename,
          sha256: configVersions.sha256,
          message: configVersions.message,
          created_at: configVersions.createdAt,
          author_steam_id64: configVersions.authorSteamId64,
          author_label: configVersions.authorLabel,
        })
        .from(configVersions)
        .where(
          and(
            eq(configVersions.serverId, row.id),
            like(configVersions.message, 'deletion-backup-marker%'),
          ),
        )
        .orderBy(desc(configVersions.createdAt));

      const dedup = new Map<string, (typeof backups)[number]>();
      for (const b of backups) {
        if (!dedup.has(b.filename)) dedup.set(b.filename, b);
      }

      return {
        server: {
          id: row.id,
          display_name: row.displayName,
          slug: row.slug,
          description: row.description,
          deleted_at: row.deletedAt,
          deleted_by_steam_id64: row.deletedBySteamId64 ? String(row.deletedBySteamId64) : null,
          deletion_backup_marker_id: row.deletionBackupMarkerId,
          tags: row.tags,
        },
        settings: settingsRow
          ? {
              install_path: settingsRow.installPath,
              game_port: settingsRow.gamePort,
              query_port: settingsRow.queryPort,
              beacon_port: settingsRow.beaconPort,
              rcon_port: settingsRow.rconPort,
              max_players: settingsRow.maxPlayers,
              tickrate: settingsRow.tickrate,
              multihome: settingsRow.multihome,
            }
          : null,
        backups: Array.from(dedup.values()).map((b) => ({
          id: b.id,
          filename: b.filename,
          sha256_hex: b.sha256.toString('hex'),
          message: b.message,
          created_at: b.created_at,
          author_steam_id64: b.author_steam_id64 ? String(b.author_steam_id64) : null,
          author_label: b.author_label,
        })),
      };
    },
  );

  fast.get(
    '/api/v1/servers/archive/:id/configs/:filename',
    {
      config: { permissions: ['config:view'], audit: false },
      schema: { params: idAndFilename },
    },
    async (req, reply) => {
      const archive = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNotNull(servers.deletedAt)),
      });
      if (!archive) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const rows = await app.db
        .select({
          id: configVersions.id,
          content: configVersions.content,
          sha256: configVersions.sha256,
          created_at: configVersions.createdAt,
          message: configVersions.message,
        })
        .from(configVersions)
        .where(
          and(
            eq(configVersions.serverId, req.params.id),
            eq(configVersions.filename, req.params.filename),
            like(configVersions.message, 'deletion-backup-marker%'),
          ),
        )
        .orderBy(desc(configVersions.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      return {
        id: row.id,
        filename: req.params.filename,
        content: row.content,
        sha256_hex: row.sha256.toString('hex'),
        created_at: row.created_at,
        message: row.message,
      };
    },
  );

  fast.post(
    '/api/v1/servers/archive/:id/restore',
    {
      config: {
        permissions: ['server:install'],
        audit: { action: 'server.restore', resource: 'server' },
      },
      schema: { params: idParam, body: restoreBody },
    },
    async (req, reply) => {
      const archive = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNotNull(servers.deletedAt)),
      });
      if (!archive) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const slug = req.body.slug;
      const existingActive = await app.db.query.servers.findFirst({
        where: and(eq(servers.slug, slug), isNull(servers.deletedAt)),
      });
      if (existingActive) {
        reply.code(409);
        return { error: 'slug_in_use' };
      }

      const archiveSettings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, archive.id),
      });
      if (!archiveSettings) {
        reply.code(409);
        return { error: 'archive_settings_missing' };
      }

      const newId = uuidv7();
      const displayName = req.body.display_name ?? `${archive.displayName} (restored)`;
      const gamePort = req.body.game_port ?? archiveSettings.gamePort;
      const queryPort = req.body.query_port ?? archiveSettings.queryPort;
      const beaconPort = req.body.beacon_port ?? archiveSettings.beaconPort;
      const rconPort = req.body.rcon_port ?? archiveSettings.rconPort;

      await app.db.transaction(async (tx) => {
        await tx.insert(servers).values({
          id: newId,
          displayName,
          slug,
          description: archive.description,
          status: 'pending',
          runtime: 'container',
          tags: archive.tags,
          timezone: archive.timezone,
        });
        await tx.insert(serverSettings).values({
          serverId: newId,
          installPath: `${PANEL_CONFIGS_ROOT}/${newId}`,
          gamePort,
          queryPort,
          beaconPort,
          rconPort,
          maxPlayers: archiveSettings.maxPlayers,
          tickrate: archiveSettings.tickrate,
          multihome: archiveSettings.multihome,
          extraArgs: archiveSettings.extraArgs,
          launchArgsOverride: archiveSettings.launchArgsOverride,
          cpuAffinity: archiveSettings.cpuAffinity,
          cpuWeight: archiveSettings.cpuWeight,
          niceness: archiveSettings.niceness,
          memoryHighMb: archiveSettings.memoryHighMb,
          memoryMaxMb: archiveSettings.memoryMaxMb,
          ioWeight: archiveSettings.ioWeight,
        });
        const rconPassword = randomBytes(24).toString('base64url');
        const blob = encrypt(app.encryptionKey, rconPassword);
        await tx.insert(serverCredentials).values({
          serverId: newId,
          rconPort,
          rconPasswordEncrypted: serialize(blob),
        });
      });

      app.liveBus.publish({
        type: 'server.restored',
        ts: new Date().toISOString(),
        data: { old_server_id: archive.id, new_server_id: newId },
      });

      reply.code(201);
      return {
        id: newId,
        archive_id: archive.id,
        slug,
        display_name: displayName,
        status: 'pending',
        ports: {
          game: gamePort,
          query: queryPort,
          beacon: beaconPort,
          rcon: rconPort,
        },
        next_steps: [
          'POST /api/v1/servers/:id/install',
          'POST /api/v1/servers/:id/restore-configs { from_archive_id }',
          'POST /api/v1/servers/:id/start',
        ],
      };
    },
  );

  fast.post(
    '/api/v1/servers/:id/restore-configs',
    {
      config: {
        permissions: ['config:edit'],
        audit: { action: 'server.restore_configs', resource: 'server' },
      },
      schema: { params: idParam, body: restoreConfigsBody },
    },
    async (req, reply) => {
      const target = await app.db.query.servers.findFirst({
        where: eq(servers.id, req.params.id),
      });
      if (!target || target.deletedAt) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const archive = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.body.from_archive_id), isNotNull(servers.deletedAt)),
      });
      if (!archive) {
        reply.code(404);
        return { error: 'archive_not_found' };
      }
      const result = await restoreConfigsFromArchive(
        {
          db: app.db,
          bridge: app.bridge,
          log: req.log,
          actorSteamId64: req.user?.steamId64 ?? null,
          actorIp: req.ip ?? null,
          actorLabel: req.user ? `steam:${req.user.steamId64}` : 'system',
        },
        req.params.id,
        archive.id,
      );
      return { ok: true, ...result };
    },
  );
};

export default archiveRoutes;
