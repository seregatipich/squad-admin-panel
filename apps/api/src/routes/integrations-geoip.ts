import {
  GEOIP_SETTINGS_SINGLETON_ID,
  type GeoipSettingsRow,
  geoipSettings,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
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

/**
 * MaxMind GeoIP credentials (singleton row). Authentication is the global
 * `plugins/auth.ts` hook and authorization is `config.permissions`; the PUT
 * declares `config.audit` and fills `req.auditSnapshots`, so every attempt —
 * refusals included — is audited with the license key masked.
 *
 * Only the credentials and the switch are stored here. worker-log-ingest
 * downloads the GeoLite2 database once GeoIP is enabled and then fills
 * `db_path` and `last_refreshed_at`; until `db_present` is true the settings
 * page warns that the key is not used yet.
 */
const integrationsGeoipRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/integrations/geoip',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
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
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'integration.geoip.update', resource: 'geoip_settings' },
      },
    },
    async (req) => {
      const licenseKey = req.body.license_key;
      const encryptedKey =
        typeof licenseKey === 'string' ? serialize(encrypt(app.encryptionKey, licenseKey)) : null;

      // Same singleton pattern as PUT /integrations/discord: ensure the row,
      // lock it, then update from the locked state, so concurrent first-time
      // PUTs neither 500 on the primary key nor lose each other's fields.
      const { created, existing, updated } = await app.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(geoipSettings)
          .values({ id: GEOIP_SETTINGS_SINGLETON_ID })
          .onConflictDoNothing()
          .returning({ id: geoipSettings.id });
        const [current] = await tx
          .select()
          .from(geoipSettings)
          .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID))
          .for('update');
        if (!current) throw new Error('geoip_settings singleton missing after upsert');

        const [row] = await tx
          .update(geoipSettings)
          .set({
            accountId: req.body.account_id !== undefined ? req.body.account_id : current.accountId,
            enabled: req.body.enabled ?? current.enabled,
            licenseKeyEncrypted:
              licenseKey === undefined ? current.licenseKeyEncrypted : encryptedKey,
            updatedAt: new Date(),
          })
          .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID))
          .returning();
        if (!row) throw new Error('geoip_settings singleton update returned no row');
        return { created: inserted.length > 0, existing: current, updated: row };
      });

      const after = geoipView(updated);
      req.auditSnapshots = {
        before: geoipView(created ? null : existing),
        after,
        targetId: GEOIP_SETTINGS_SINGLETON_ID,
      };
      return after;
    },
  );
};

export default integrationsGeoipRoutes;
