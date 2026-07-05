import { GEOIP_SETTINGS_SINGLETON_ID, geoipSettings } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptString, deserialize } from '../../src/lib/crypto.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(920001);
const LICENSE_KEY = 'maxmind-fake-license-key-0011223344';

let h: IntegrationHarness;
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  invalidateAllPermissionCaches();
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GeoIP settings (MaxMind creds)', () => {
  it('returns an unconfigured default before any key is entered', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/geoip',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ license_key_configured: boolean; enabled: boolean }>();
    expect(body.license_key_configured).toBe(false);
    expect(body.enabled).toBe(false);
  });

  it('rejects an anonymous caller', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/integrations/geoip' });
    expect(resp.statusCode).toBe(401);
  });

  it('stores the account id + encrypted license key and masks it on read', async () => {
    const cookie = await loginAsOwner(h);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/geoip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { account_id: '123456', license_key: LICENSE_KEY, enabled: true },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json<{
      account_id: string;
      license_key_configured: boolean;
      license_key_mask: string | null;
      enabled: boolean;
    }>();
    expect(body.account_id).toBe('123456');
    expect(body.license_key_configured).toBe(true);
    expect(body.license_key_mask).not.toContain(LICENSE_KEY);
    expect(body.enabled).toBe(true);

    const [row] = await h.db
      .select()
      .from(geoipSettings)
      .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID))
      .limit(1);
    const stored = row?.licenseKeyEncrypted;
    expect(stored).not.toBeNull();
    const decrypted = decryptString(
      h.app.encryptionKey,
      deserialize(Buffer.from(stored as unknown as Buffer)),
    );
    expect(decrypted).toBe(LICENSE_KEY);
  });

  it('clears the key when license_key is set to null', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/geoip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { license_key: null, enabled: false },
    });
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/geoip',
      headers: { cookie },
    });
    const body = resp.json<{ license_key_configured: boolean; enabled: boolean }>();
    expect(body.license_key_configured).toBe(false);
    expect(body.enabled).toBe(false);
  });
});
