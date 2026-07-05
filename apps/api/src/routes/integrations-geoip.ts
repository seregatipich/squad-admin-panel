import {
  GEOIP_SETTINGS_SINGLETON_ID,
  type GeoipSettingsRow,
  geoipSettings,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { encrypt, serialize } from '../lib/crypto.js';

const INTEGRATION_PERMISSION = 'integration:manage' as const;
const LICENSE_KEY_MASK = '••••••••';

const putGeoipBody = z.object({
  account_id: z.string().trim().max(32).nullable().optional(),
  license_key: z.string().trim().min(1).max(120).nullable().optional(),
  enabled: z.boolean().optional(),
});

function geoipView(
  row: Pick<
    GeoipSettingsRow,
    'accountId' | 'licenseKeyEncrypted' | 'enabled' | 'dbPath' | 'lastRefreshedAt' | 'updatedAt'
  > | null,
) {
  if (!row) {
    return {
      account_id: null,
      license_key_configured: false,
      license_key_mask: null,
      enabled: false,
      db_present: false,
      last_refreshed_at: null,
      updated_at: null,
    };
  }
  const configured = row.licenseKeyEncrypted != null;
  return {
    account_id: row.accountId,
    license_key_configured: configured,
    license_key_mask: configured ? LICENSE_KEY_MASK : null,
    enabled: row.enabled,
    db_present: row.dbPath != null,
    last_refreshed_at: row.lastRefreshedAt ? row.lastRefreshedAt.toISOString() : null,
    updated_at: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

function auditActor(req: FastifyRequest): AuditActor {
  return req.user
    ? { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null }
    : { kind: 'system', label: 'http-anonymous' };
}

const isForbidden = (req: FastifyRequest, reply: FastifyReply): boolean => {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return true;
  }
  return false;
};

const integrationsGeoipRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/integrations/geoip',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
      const rows = await app.db
        .select()
        .from(geoipSettings)
        .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID))
        .limit(1);
      return geoipView(rows[0] ?? null);
    },
  );

  fast.put(
    '/api/v1/integrations/geoip',
    {
      schema: { body: putGeoipBody },
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
      const existingRows = await app.db
        .select()
        .from(geoipSettings)
        .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID))
        .limit(1);
      const existing = existingRows[0] ?? null;
      const before = geoipView(existing);

      const accountId =
        req.body.account_id !== undefined ? req.body.account_id : (existing?.accountId ?? null);
      const enabled =
        req.body.enabled !== undefined ? req.body.enabled : (existing?.enabled ?? false);
      let licenseKeyEncrypted: Buffer | null =
        existing?.licenseKeyEncrypted != null
          ? Buffer.from(existing.licenseKeyEncrypted as unknown as Buffer)
          : null;
      if (req.body.license_key === null) {
        licenseKeyEncrypted = null;
      } else if (typeof req.body.license_key === 'string') {
        licenseKeyEncrypted = serialize(encrypt(app.encryptionKey, req.body.license_key));
      }

      const now = new Date();
      if (existing) {
        await app.db
          .update(geoipSettings)
          .set({ accountId, enabled, licenseKeyEncrypted, updatedAt: now })
          .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID));
      } else {
        await app.db.insert(geoipSettings).values({
          id: GEOIP_SETTINGS_SINGLETON_ID,
          accountId,
          enabled,
          licenseKeyEncrypted,
          updatedAt: now,
        });
      }

      const after = geoipView({
        accountId,
        licenseKeyEncrypted,
        enabled,
        dbPath: existing?.dbPath ?? null,
        lastRefreshedAt: existing?.lastRefreshedAt ?? null,
        updatedAt: now,
      });
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'integration.geoip.update',
        targetType: 'geoip_settings',
        targetId: GEOIP_SETTINGS_SINGLETON_ID,
        before,
        after,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });
      return after;
    },
  );
};

export default integrationsGeoipRoutes;
