/**
 * Audit #333: private LAN addresses are an allowed RCON host by default, but an
 * operator can narrow them with `EXTERNAL_HOST_PRIVATE_ALLOWLIST`.
 */
import { serverCredentials, servers } from '@squad/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM_ID = 76561198000000778n;

const externalBody = {
  display_name: 'LAN box',
  slug: 'lan-policy',
  rcon_host: '192.168.10.20',
  rcon_port: 21_114,
  rcon_password: 'remote-rcon-secret',
  query_port: 27_165,
  game_port: 7787,
  max_players: 100,
};

let h: IntegrationHarness;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

beforeEach(async () => {
  if (!h) return;
  await h.db.update(servers).set({ deletedAt: new Date() }).where(isNull(servers.deletedAt));
});

afterEach(() => {
  if (h) h.app.config.EXTERNAL_HOST_PRIVATE_ALLOWLIST = undefined;
});

afterAll(async () => {
  await h?.cleanup();
});

async function create(cookie: string, rconHost: string) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/servers/external',
    headers: { cookie },
    payload: { ...externalBody, rcon_host: rconHost },
  });
}

describeIfDb('external RCON host private-network allowlist (#333)', () => {
  it('accepts a LAN host when the allowlist is unset (previous behaviour)', async () => {
    const cookie = await loginAsOwner(h);
    expect((await create(cookie, '192.168.10.20')).statusCode).toBe(201);
  });

  it('refuses every private host with 400 when the allowlist is "none"', async () => {
    h.app.config.EXTERNAL_HOST_PRIVATE_ALLOWLIST = 'none';
    const cookie = await loginAsOwner(h);
    for (const host of ['192.168.10.20', '10.0.0.5', '172.20.1.1', 'fd00::5']) {
      const resp = await create(cookie, host);
      expect(resp.statusCode).toBe(400);
      expect(resp.json()).toMatchObject({ error: 'rcon_host_private_not_allowed' });
    }
    const rows = await h.db.select().from(servers).where(isNull(servers.deletedAt));
    expect(rows).toHaveLength(0);
  });

  it('still accepts public hosts and hostnames when the allowlist is "none"', async () => {
    h.app.config.EXTERNAL_HOST_PRIVATE_ALLOWLIST = 'none';
    const cookie = await loginAsOwner(h);
    expect((await create(cookie, '203.0.113.10')).statusCode).toBe(201);
  });

  it('accepts only the listed private ranges', async () => {
    h.app.config.EXTERNAL_HOST_PRIVATE_ALLOWLIST = '192.168.10.0/24';
    const cookie = await loginAsOwner(h);
    expect((await create(cookie, '10.0.0.5')).statusCode).toBe(400);
    expect((await create(cookie, '192.168.10.20')).statusCode).toBe(201);
  });

  it('applies the allowlist to PUT /external-connection and leaves the stored host untouched', async () => {
    const cookie = await loginAsOwner(h);
    const created = await create(cookie, '203.0.113.10');
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    h.app.config.EXTERNAL_HOST_PRIVATE_ALLOWLIST = 'none';
    const refused = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/external-connection`,
      headers: { cookie },
      payload: { rcon_host: '10.1.2.3' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'rcon_host_private_not_allowed' });
    const [creds] = await h.db
      .select({ host: serverCredentials.rconHost })
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, id));
    expect(creds?.host).toBe('203.0.113.10');

    const portOnly = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/external-connection`,
      headers: { cookie },
      payload: { rcon_port: 21_115 },
    });
    expect(portOnly.statusCode).toBe(200);
  });
});
